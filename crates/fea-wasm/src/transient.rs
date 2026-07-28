//! Browser-facing surface over the transient Euler path.
//!
//! Shaped differently from [`crate::solve`], for two reasons that both come down
//! to a transient run being long.
//!
//! ## It is driven a frame at a time
//!
//! A steady solve is one call that returns one field. A transient run is
//! thousands of steps producing sixty fields, and doing that inside a single
//! call would mean no progress indication, no way to cancel, and every frame
//! held in Rust and in JavaScript at once. So the run is a *stateful object*:
//! the caller constructs it and then asks for one frame at a time, and can stop
//! by dropping it.
//!
//! The consequence is that [`LdgOperator`] is rebuilt once per frame.
//! `LdgOperator<'a, N, E>` borrows its mesh, basis, equation, boundary map and
//! conditions, and a `#[wasm_bindgen]` struct cannot hold both those and a thing
//! borrowing from them without self-reference. Owning the pieces and rebuilding
//! the operator is the way out, and it is cheap at frame granularity: building
//! it allocates a penalty per face, a small list per element and one gradient
//! buffer, against the thousands of operator applications a frame costs. Doing
//! it per *step* would not be cheap, and nothing here does.
//!
//! ## Bulk data does not go through serde
//!
//! `serde_wasm_bindgen` turns a `Vec<f32>` into a JavaScript `Array` of boxed
//! numbers, not a typed array. At the sixty thousand values a steady solve
//! returns that is merely wasteful; at the two million a sixty-frame run
//! produces it is tens of megabytes of boxed doubles and seconds of marshalling
//! per run. Frames are therefore returned as `Float32Array` built directly from
//! the Rust slice, and only the small metadata goes through serde.
//!
//! ## Panics are still not errors
//!
//! As in [`crate::solve`], every assertion reachable from a request is checked
//! in [`validate`] first, because a panic inside wasm aborts the instance and
//! takes the worker with it. The list below mirrors the solver's own `assert!`s:
//! `Euler::new` on the ratio of specific heats, `SlopeLimiter::new` on the TVB
//! constant, `solve_transient` on the time interval, the CFL fraction and the
//! frame count, and `PositivityLimiter::with_relative_floor` on its fraction.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use fea_dg::mesh::boundary::{BoundaryCondition, SupersonicInflow, Transmissive};
use fea_dg::mesh::dg_mesh::DgMesh;
use fea_dg::reference::dubiner::mode_count;
use fea_dg::reference::element::ReferenceElement;
use fea_dg::solver::limiter::{PositivityLimiter, SlopeLimiter};
use fea_dg::solver::residual::LdgOperator;
use fea_dg::solver::solution::Solution;
use fea_dg::solver::transient::{solve_transient, TransientOptions};
use fea_dg::{Euler, Inflow, Outflow, Primitive, SlipWall};

use crate::classify::classify_boundary;
use crate::sample::{sample_into, sample_positions, LatticeBasis};

/// Highest polynomial degree offered on the transient path.
///
/// Lower than the steady path's, and deliberately. The slope limiter scales
/// every mode above the constant one by a single factor, so an element it
/// touches is reduced to a linear reconstruction whatever its degree -- and
/// across a shock it touches most of them. Past `p = 2` the extra modes are
/// mostly paid for and then discarded, while the stable time step keeps
/// shrinking like `1 / (2p + 1)`.
const MAX_DEGREE: usize = 3;

/// Highest display lattice order.
const MAX_SUBDIVISIONS: usize = 3;

/// Ceiling on frames per run.
const MAX_FRAMES: usize = 240;

/// Ceiling on `elements * modes`, the size of one conserved variable's
/// coefficient vector. Four variables makes the state four times this.
const MAX_DEGREES_OF_FREEDOM: usize = 200_000;

/// Ceiling on the values in a single frame, which is what crosses to JavaScript
/// sixty times a run.
const MAX_FRAME_VALUES: usize = 4_000_000;

/// Ceiling on steps per frame, so a mis-sized problem stops rather than hangs.
///
/// A frame that needs more than this is one where the CFL condition and the
/// requested end time disagree by orders of magnitude -- almost always a wave
/// speed far larger than the geometry, which no amount of waiting fixes.
const MAX_STEPS_PER_FRAME: usize = 20_000;

/// A gas state as the UI states it: primitive variables, which are the ones a
/// person can reason about.
#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq)]
pub struct GasState {
    pub density: f64,
    pub velocity: [f64; 2],
    pub pressure: f64,
}

impl GasState {
    fn to_primitive(self) -> Primitive {
        Primitive {
            density: self.density,
            velocity: self.velocity,
            pressure: self.pressure,
        }
    }

    fn check(&self, what: &str) -> Result<(), String> {
        if !self.density.is_finite() || self.density <= 0.0 {
            return Err(format!("{what} has a density of {}", self.density));
        }
        if !self.pressure.is_finite() || self.pressure <= 0.0 {
            return Err(format!("{what} has a pressure of {}", self.pressure));
        }
        if self.velocity.iter().any(|value| !value.is_finite()) {
            return Err(format!("{what} has a non-finite velocity"));
        }
        Ok(())
    }
}

/// A boundary condition for a gas.
///
/// Nothing here resembles the steady path's `alpha u + beta (J . n) = g`,
/// because a hyperbolic boundary is not a constraint on the solution but a
/// statement about what is on the other side of it.
#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GasConditionSpec {
    /// A reflecting wall. Gas slips along it and does not pass through.
    SlipWall,
    /// Plain extrapolation. Exact only where the flow leaves faster than sound;
    /// below that it under-specifies the boundary and part of every wave comes
    /// back. Kept because it is the simplest thing that can be asked for, and
    /// because it is what `Outflow` reduces to when the flow is supersonic.
    Transmissive,
    /// Gas entering, at a state that may vary with time. The solver decides per
    /// face whether the inflow is supersonic -- and so whether all four
    /// components may be imposed -- from the flow itself.
    Inflow {
        state: GasState,
        #[serde(default)]
        schedule: InflowSchedule,
    },
    /// Gas leaving, against a back pressure. Non-reflecting when subsonic;
    /// identical to `Transmissive` when supersonic.
    Outflow { pressure: f64 },
    /// A prescribed incoming state, imposed in full whatever the flow does.
    ///
    /// Retained for the case where that is genuinely wanted. `Inflow` is the one
    /// to reach for: it does this where it is correct and the subsonic thing
    /// where it is not.
    SupersonicInflow { state: GasState },
}

/// How an inflow's state moves with time.
///
/// One mechanism rather than three: each variant produces a factor `s(t)` and
/// the inflow interpolates from the ambient state to its target by it, in
/// primitive variables. That keeps a ramp, a pulse and an oscillation the same
/// object as far as the solver is concerned, and keeps `Steady` exactly free.
#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InflowSchedule {
    #[default]
    Steady,
    /// Rises from ambient to the target over `over`, then holds.
    Ramp { over: f64 },
    /// Ambient until `start`, the target until `end`, ambient after.
    Pulse { start: f64, end: f64 },
    /// Oscillates about the midpoint between ambient and target.
    Oscillation { period: f64 },
}

impl InflowSchedule {
    /// The factor at time `t`: 0 is ambient, 1 is the stated target.
    pub fn factor(&self, t: f64) -> f64 {
        match *self {
            InflowSchedule::Steady => 1.0,
            InflowSchedule::Ramp { over } => (t / over).clamp(0.0, 1.0),
            InflowSchedule::Pulse { start, end } => {
                if t >= start && t < end {
                    1.0
                } else {
                    0.0
                }
            }
            InflowSchedule::Oscillation { period } => {
                0.5 - 0.5 * (std::f64::consts::TAU * t / period).cos()
            }
        }
    }

    fn check(&self) -> Result<(), String> {
        match *self {
            InflowSchedule::Steady => Ok(()),
            InflowSchedule::Ramp { over } => {
                if over > 0.0 && over.is_finite() {
                    Ok(())
                } else {
                    Err(format!("a ramp needs a positive duration, got {over}"))
                }
            }
            InflowSchedule::Pulse { start, end } => {
                if start.is_finite() && end > start {
                    Ok(())
                } else {
                    Err(format!("a pulse must end ({end}) after it starts ({start})"))
                }
            }
            InflowSchedule::Oscillation { period } => {
                if period > 0.0 && period.is_finite() {
                    Ok(())
                } else {
                    Err(format!("an oscillation needs a positive period, got {period}"))
                }
            }
        }
    }
}

/// The state the run starts from, in primitive variables.
#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InitialSpec {
    /// The same state everywhere.
    Uniform { state: GasState },
    /// Two states meeting across a plane: a shock tube. `left` is the side the
    /// normal points away from.
    Riemann {
        normal: [f64; 2],
        position: f64,
        left: GasState,
        right: GasState,
    },
    /// A disc of one state inside another: a blast.
    Blast {
        centre: [f64; 2],
        radius: f64,
        inside: GasState,
        outside: GasState,
    },
}

/// Which scalar is drawn.
///
/// Four conserved variables cannot be shown at once, and none of them is what a
/// person wants to look at: `rho u` is not a picture. These are.
#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum DerivedField {
    #[default]
    Density,
    Pressure,
    /// Total energy per unit volume: the conserved variable itself.
    Energy,
    /// Internal energy per unit mass, `p / ((gamma - 1) rho)`. Proportional to
    /// temperature, and the part of the energy that is not the motion -- which
    /// is what distinguishes a shock from a fast smooth flow.
    Temperature,
    /// `|v|`.
    Speed,
    /// `|v| / c`. The one that shows where a flow has gone supersonic.
    Mach,
}

#[derive(Debug, Deserialize)]
pub struct TransientRequest {
    /// Interleaved `[x0, y0, ...]` -- exactly `MeshResponse::vertices`.
    pub vertices: Vec<f64>,
    /// Interleaved corner indices -- exactly `MeshResponse::triangles`.
    pub triangles: Vec<u32>,

    /// The edges of the drawn loops, interleaved `[ax, ay, bx, by, ...]`.
    pub segments: Vec<f64>,
    /// One tag per segment, indexing `conditions`.
    pub segment_tags: Vec<u16>,
    pub conditions: Vec<GasConditionSpec>,

    pub initial: InitialSpec,

    #[serde(default = "default_gamma")]
    pub gamma: f64,
    #[serde(default = "default_degree")]
    pub degree: usize,

    pub end_time: f64,
    #[serde(default = "default_frames")]
    pub frames: usize,
    #[serde(default = "default_cfl")]
    pub cfl: f64,
    /// TVB constant for the slope limiter. Zero limits wherever the
    /// reconstruction leaves its neighbours' range, which is the safe choice.
    #[serde(default)]
    pub limiter: f64,

    #[serde(default = "default_subdivisions")]
    pub subdivisions: usize,
    #[serde(default)]
    pub field: DerivedField,
}

fn default_gamma() -> f64 {
    fea_dg::equation::euler::AIR
}
fn default_degree() -> usize {
    1
}
fn default_frames() -> usize {
    60
}
fn default_cfl() -> f64 {
    0.3
}
fn default_subdivisions() -> usize {
    2
}

/// Everything about a run that is fixed once it starts.
#[derive(Debug, Serialize)]
pub struct TransientSetup {
    /// Sub-triangle corners as local lattice indices, shared by every element.
    pub sub_triangles: Vec<u32>,
    pub sample_stride: usize,
    pub subdivisions: usize,
    pub element_count: usize,
    pub mode_count: usize,
    pub degree: usize,
    pub frames: usize,
    /// Boundary faces no segment claimed. Nonzero means the conditions near them
    /// are not the ones that were asked for.
    pub unclassified_faces: usize,
    pub worst_match_distance: f64,
}

/// How a run is going, or how it went.
#[derive(Debug, Serialize, Clone, Copy)]
pub struct TransientProgress {
    pub frame: usize,
    pub frames: usize,
    pub time: f64,
    pub steps: usize,
    pub smallest_step: f64,
    /// The state stopped being finite, or a cell average left the admissible
    /// set. The run is over and what it produced is not a solution.
    pub blew_up: bool,
    /// A frame needed more steps than its cap. Almost always a wave speed far
    /// out of proportion to the geometry.
    pub hit_step_cap: bool,
    /// Element-stages whose cell average was already inadmissible when the
    /// positivity limiter reached it. Non-zero means the scheme failed upstream
    /// of the limiter; the picture will still render.
    pub unrecoverable: usize,
}

/// A boundary condition owned by the run.
///
/// The three variants are distinct types in the solver, and a runtime-sized
/// `Vec` of trait objects needs one type, so they are enumerated here.
/// The value function an owned inflow closes over. Boxed for the same reason the
/// steady path boxes its own: every closure has its own anonymous type, so a
/// runtime-sized `Vec` of them cannot be built otherwise.
type TargetFn = Box<dyn Fn([f64; 2], [f64; 2], f64) -> Primitive>;

enum OwnedGasCondition {
    SlipWall(SlipWall),
    Transmissive(Transmissive),
    Supersonic(SupersonicInflow<4>),
    Inflow(Inflow<TargetFn>),
    Outflow(Outflow),
}

impl BoundaryCondition<4> for OwnedGasCondition {
    fn coefficients(&self) -> ([f64; 4], [f64; 4]) {
        match self {
            OwnedGasCondition::SlipWall(condition) => condition.coefficients(),
            OwnedGasCondition::Transmissive(condition) => {
                BoundaryCondition::<4>::coefficients(condition)
            }
            OwnedGasCondition::Supersonic(condition) => condition.coefficients(),
            OwnedGasCondition::Inflow(condition) => condition.coefficients(),
            OwnedGasCondition::Outflow(condition) => condition.coefficients(),
        }
    }

    fn value(&self, x: [f64; 2], normal: [f64; 2], t: f64) -> [f64; 4] {
        match self {
            OwnedGasCondition::SlipWall(condition) => condition.value(x, normal, t),
            OwnedGasCondition::Transmissive(condition) => {
                BoundaryCondition::<4>::value(condition, x, normal, t)
            }
            OwnedGasCondition::Supersonic(condition) => condition.value(x, normal, t),
            OwnedGasCondition::Inflow(condition) => condition.value(x, normal, t),
            OwnedGasCondition::Outflow(condition) => condition.value(x, normal, t),
        }
    }

    /// Forwarded, and this is the one that must not be forgotten.
    ///
    /// The trait's default derives a ghost from the coefficients, which for a
    /// wall's inert coefficients is the interior state -- so a wall that did not
    /// forward would silently become an open boundary. Every shock would pass
    /// straight through every wall, and nothing else about the run would look
    /// wrong.
    fn exterior(&self, interior: &[f64; 4], prescribed: &[f64; 4], normal: [f64; 2]) -> [f64; 4] {
        match self {
            OwnedGasCondition::SlipWall(condition) => {
                condition.exterior(interior, prescribed, normal)
            }
            OwnedGasCondition::Transmissive(condition) => {
                BoundaryCondition::<4>::exterior(condition, interior, prescribed, normal)
            }
            OwnedGasCondition::Supersonic(condition) => {
                condition.exterior(interior, prescribed, normal)
            }
            OwnedGasCondition::Inflow(condition) => {
                condition.exterior(interior, prescribed, normal)
            }
            OwnedGasCondition::Outflow(condition) => {
                condition.exterior(interior, prescribed, normal)
            }
        }
    }
}

/// The state an unstated schedule interpolates away from: still air at unit
/// density and pressure, which is what the rest of the domain starts as.
fn ambient() -> Primitive {
    Primitive::at_rest(1.0, 1.0)
}

fn build_condition(gas: &Euler, spec: &GasConditionSpec) -> OwnedGasCondition {
    match *spec {
        GasConditionSpec::SlipWall => OwnedGasCondition::SlipWall(SlipWall),
        GasConditionSpec::Transmissive => OwnedGasCondition::Transmissive(Transmissive),
        GasConditionSpec::SupersonicInflow { state } => OwnedGasCondition::Supersonic(
            SupersonicInflow::new(gas.conserved(&state.to_primitive())),
        ),
        GasConditionSpec::Outflow { pressure } => {
            OwnedGasCondition::Outflow(Outflow::new(*gas, pressure))
        }
        GasConditionSpec::Inflow { state, schedule } => {
            let target = state.to_primitive();
            let rest = ambient();
            // Interpolated in primitive variables, because those are what the
            // schedule is stated in and what a person reasons about. Converting
            // to conserved first and blending there would ramp the momentum and
            // the energy independently, which passes through states no one
            // asked for.
            let value: TargetFn = Box::new(move |_, _, t| {
                let factor = schedule.factor(t);
                Primitive {
                    density: rest.density + factor * (target.density - rest.density),
                    velocity: [
                        rest.velocity[0] + factor * (target.velocity[0] - rest.velocity[0]),
                        rest.velocity[1] + factor * (target.velocity[1] - rest.velocity[1]),
                    ],
                    pressure: rest.pressure + factor * (target.pressure - rest.pressure),
                }
            });
            OwnedGasCondition::Inflow(Inflow::new(*gas, value))
        }
    }
}

/// Everything that could otherwise reach an assertion inside the solver, or
/// start a run that cannot finish.
pub fn validate(request: &TransientRequest) -> Result<(), String> {
    if request.vertices.is_empty() || request.triangles.is_empty() {
        return Err("the request carries no mesh".into());
    }
    if request.vertices.iter().any(|value| !value.is_finite()) {
        return Err("the mesh contains a non-finite coordinate".into());
    }
    if request.segments.len() % 4 != 0 {
        return Err(format!(
            "segments must come in groups of four coordinates; got {}",
            request.segments.len()
        ));
    }
    if request.segments.len() != request.segment_tags.len() * 4 {
        return Err(format!(
            "{} segments were sent with {} tags",
            request.segments.len() / 4,
            request.segment_tags.len()
        ));
    }
    if request.segments.iter().any(|value| !value.is_finite()) {
        return Err("a boundary segment has a non-finite coordinate".into());
    }

    // Tag 0 is the fallback for a face no segment claims, so it must exist even
    // when no segment names it.
    if request.conditions.is_empty() {
        return Err("no boundary conditions were supplied".into());
    }
    if let Some(&tag) = request
        .segment_tags
        .iter()
        .find(|&&tag| tag as usize >= request.conditions.len())
    {
        return Err(format!(
            "a boundary segment is tagged {tag}, but only {} conditions were supplied",
            request.conditions.len()
        ));
    }
    for condition in &request.conditions {
        match condition {
            GasConditionSpec::SupersonicInflow { state } => state.check("an inflow condition")?,
            GasConditionSpec::Inflow { state, schedule } => {
                state.check("an inflow condition")?;
                schedule.check()?;
            }
            // `Outflow::new` asserts this.
            GasConditionSpec::Outflow { pressure } => {
                if !(*pressure > 0.0) || !pressure.is_finite() {
                    return Err(format!(
                        "an outflow needs a positive back pressure; got {pressure}"
                    ));
                }
            }
            GasConditionSpec::SlipWall | GasConditionSpec::Transmissive => {}
        }
    }

    match &request.initial {
        InitialSpec::Uniform { state } => state.check("the initial state")?,
        InitialSpec::Riemann {
            normal,
            position,
            left,
            right,
        } => {
            left.check("the left state")?;
            right.check("the right state")?;
            if !position.is_finite() || normal.iter().any(|value| !value.is_finite()) {
                return Err("the initial jump is not finite".into());
            }
            if normal[0].hypot(normal[1]) < 1e-12 {
                return Err("the initial jump has no direction; its normal is zero".into());
            }
        }
        InitialSpec::Blast {
            centre,
            radius,
            inside,
            outside,
        } => {
            inside.check("the state inside the blast")?;
            outside.check("the state outside the blast")?;
            if centre.iter().any(|value| !value.is_finite()) {
                return Err("the blast centre is not finite".into());
            }
            if !(*radius > 0.0) || !radius.is_finite() {
                return Err(format!("the blast radius must be positive; got {radius}"));
            }
        }
    }

    // `Euler::new` asserts this.
    if !(request.gamma > 1.0) || !request.gamma.is_finite() {
        return Err(format!(
            "the ratio of specific heats must exceed 1; got {}",
            request.gamma
        ));
    }
    if request.degree < 1 || request.degree > MAX_DEGREE {
        return Err(format!(
            "polynomial degree must be between 1 and {MAX_DEGREE}; got {}",
            request.degree
        ));
    }
    if request.subdivisions < 1 || request.subdivisions > MAX_SUBDIVISIONS {
        return Err(format!(
            "subdivisions must be between 1 and {MAX_SUBDIVISIONS}; got {}",
            request.subdivisions
        ));
    }
    // `solve_transient` asserts these.
    if !(request.end_time > 0.0) || !request.end_time.is_finite() {
        return Err(format!(
            "the end time must be positive; got {}",
            request.end_time
        ));
    }
    if !(request.cfl > 0.0) || request.cfl > 1.0 {
        return Err(format!(
            "the CFL fraction must lie in (0, 1]; got {}",
            request.cfl
        ));
    }
    if request.frames < 2 || request.frames > MAX_FRAMES {
        return Err(format!(
            "a run needs between 2 and {MAX_FRAMES} frames; got {}",
            request.frames
        ));
    }
    // `SlopeLimiter::new` asserts this.
    if request.limiter < 0.0 || !request.limiter.is_finite() {
        return Err(format!(
            "the limiter constant must not be negative; got {}",
            request.limiter
        ));
    }

    let elements = request.triangles.len() / 3;
    let unknowns = elements.saturating_mul(mode_count(request.degree));
    if unknowns > MAX_DEGREES_OF_FREEDOM {
        return Err(format!(
            "this problem has {unknowns} unknowns per variable, above the \
             {MAX_DEGREES_OF_FREEDOM} ceiling. Use a larger maximum element area, or a lower \
             polynomial degree."
        ));
    }

    let per_frame = elements.saturating_mul(crate::sample::lattice_size(request.subdivisions));
    if per_frame > MAX_FRAME_VALUES {
        return Err(format!(
            "each frame would carry {per_frame} values, above the {MAX_FRAME_VALUES} ceiling. \
             Use fewer subdivisions, or a larger maximum element area."
        ));
    }

    Ok(())
}

/// Builds the initial conserved state as a function of position.
fn initial_state(gas: &Euler, spec: &InitialSpec) -> Box<dyn Fn([f64; 2]) -> [f64; 4]> {
    match *spec {
        InitialSpec::Uniform { state } => {
            let conserved = gas.conserved(&state.to_primitive());
            Box::new(move |_| conserved)
        }
        InitialSpec::Riemann {
            normal,
            position,
            left,
            right,
        } => {
            let length = normal[0].hypot(normal[1]);
            let unit = [normal[0] / length, normal[1] / length];
            let left = gas.conserved(&left.to_primitive());
            let right = gas.conserved(&right.to_primitive());
            Box::new(move |[x, y]| {
                if x * unit[0] + y * unit[1] < position {
                    left
                } else {
                    right
                }
            })
        }
        InitialSpec::Blast {
            centre,
            radius,
            inside,
            outside,
        } => {
            let inside = gas.conserved(&inside.to_primitive());
            let outside = gas.conserved(&outside.to_primitive());
            Box::new(move |[x, y]| {
                if (x - centre[0]).hypot(y - centre[1]) < radius {
                    inside
                } else {
                    outside
                }
            })
        }
    }
}

/// A transient run in progress.
///
/// Constructed from a request, then pulled one frame at a time. Dropping it
/// cancels the run.
#[wasm_bindgen]
pub struct TransientRun {
    mesh: DgMesh,
    reference: ReferenceElement,
    gas: Euler,
    owned: Vec<OwnedGasCondition>,
    map: fea_dg::mesh::boundary::BoundaryMap,
    state: Solution<4>,

    lattice: LatticeBasis,
    positions: Vec<f32>,
    values: Vec<f32>,
    /// Element centroids, in physical coordinates. Static, like `positions`.
    vector_origins: Vec<f32>,
    /// `[vx, vy]` per element, rebuilt each frame.
    vectors: Vec<f32>,

    field: DerivedField,
    limiter: f64,
    cfl: f64,
    end_time: f64,
    frames: usize,

    frame: usize,
    time: f64,
    steps: usize,
    smallest_step: f64,
    blew_up: bool,
    hit_step_cap: bool,
    unrecoverable: usize,

    setup: TransientSetup,
}

#[wasm_bindgen]
impl TransientRun {
    /// Prepares a run. Does no stepping: the caller gets the setup and the first
    /// frame before anything expensive happens, so a mis-stated problem shows
    /// its geometry rather than hanging.
    #[wasm_bindgen(constructor)]
    pub fn new(request: JsValue) -> Result<TransientRun, JsValue> {
        let request: TransientRequest = serde_wasm_bindgen::from_value(request)
            .map_err(|error| JsValue::from_str(&format!("bad transient request: {error}")))?;
        Self::start(request).map_err(|error| JsValue::from_str(&error))
    }

    /// Steps to the next frame time and returns the sampled field.
    ///
    /// Returns `null` once every frame has been produced.
    pub fn advance(&mut self) -> Result<JsValue, JsValue> {
        match self.advance_frame() {
            Ok(None) => Ok(JsValue::NULL),
            Ok(Some(values)) => Ok(js_sys::Float32Array::from(values).into()),
            Err(error) => Err(JsValue::from_str(&error)),
        }
    }

    /// The sample positions, which never change. Fetched once per run.
    pub fn positions(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(&self.positions[..])
    }

    /// Where the velocity arrows are anchored: one point per element. Static,
    /// so it crosses once per run like `positions`.
    pub fn vector_origins(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(&self.vector_origins[..])
    }

    /// `[vx, vy]` per element for the frame just produced by `advance`.
    pub fn vectors(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(&self.vectors[..])
    }

    /// What is fixed about this run: lattice, counts, boundary classification.
    pub fn setup(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.setup)
            .map_err(|error| JsValue::from_str(&format!("{error}")))
    }

    /// How the run is going.
    pub fn progress(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&TransientProgress {
            frame: self.frame,
            frames: self.frames,
            time: self.time,
            steps: self.steps,
            smallest_step: self.smallest_step,
            blew_up: self.blew_up,
            hit_step_cap: self.hit_step_cap,
            unrecoverable: self.unrecoverable,
        })
        .map_err(|error| JsValue::from_str(&format!("{error}")))
    }

    /// Frames not yet produced.
    pub fn remaining(&self) -> usize {
        self.frames.saturating_sub(self.frame)
    }
}

impl TransientRun {
    /// The fallible half of the constructor, in plain Rust so tests can use it
    /// without a JavaScript value.
    pub fn start(request: TransientRequest) -> Result<TransientRun, String> {
        validate(&request)?;

        let mesh = DgMesh::from_arrays(&request.vertices, &request.triangles)
            .map_err(|error| format!("the mesh cannot be solved on: {error}"))?;
        let reference = ReferenceElement::new(request.degree);
        let gas = Euler::new(request.gamma);

        let owned: Vec<OwnedGasCondition> = request
            .conditions
            .iter()
            .map(|spec| build_condition(&gas, spec))
            .collect();
        let classification = classify_boundary(&mesh, &request.segments, &request.segment_tags, 0);

        let lattice = LatticeBasis::new(request.degree, request.subdivisions);
        let positions = sample_positions(&mesh, &lattice);

        let state = Solution::<4>::project(&mesh, &reference, initial_state(&gas, &request.initial));

        let setup = TransientSetup {
            sub_triangles: crate::sample::sub_triangles(request.subdivisions),
            sample_stride: lattice.stride(),
            subdivisions: request.subdivisions,
            element_count: mesh.n_elements(),
            mode_count: reference.n_modes(),
            degree: request.degree,
            frames: request.frames,
            unclassified_faces: classification.unclassified,
            worst_match_distance: classification.worst_relative_distance,
        };

        Ok(TransientRun {
            values: vec![0.0; mesh.n_elements() * lattice.stride()],
            vector_origins: (0..mesh.n_elements())
                .flat_map(|element| {
                    let [x, y] = mesh.geometry(element).centroid;
                    [x as f32, y as f32]
                })
                .collect(),
            vectors: vec![0.0; mesh.n_elements() * 2],
            mesh,
            reference,
            gas,
            owned,
            map: classification.map,
            state,
            lattice,
            positions,
            field: request.field,
            limiter: request.limiter,
            cfl: request.cfl,
            end_time: request.end_time,
            frames: request.frames,
            frame: 0,
            time: 0.0,
            steps: 0,
            smallest_step: f64::INFINITY,
            blew_up: false,
            hit_step_cap: false,
            unrecoverable: 0,
            setup,
        })
    }

    /// Steps to the next frame and samples it. `None` once the run is done.
    pub fn advance_frame(&mut self) -> Result<Option<&[f32]>, String> {
        if self.frame >= self.frames {
            return Ok(None);
        }
        if self.blew_up || self.hit_step_cap {
            return Err("the run has already failed; no further frames are meaningful".into());
        }

        // Frame 0 is the initial condition, limited but not stepped.
        if self.frame > 0 {
            let span = self.end_time / (self.frames - 1) as f64;
            let target = span * self.frame as f64;
            self.step_to(target)?;
        }

        let field = self.field;
        let gas = self.gas;
        sample_into(
            &mut self.values,
            &self.mesh,
            &self.state,
            &self.lattice,
            |state| derive(&gas, field, state),
        )?;

        // Velocity is sampled separately, at element centroids rather than on
        // the display lattice. An arrow at every lattice point would be a
        // thicket rather than a picture, and one arrow per element is already
        // dense enough to need thinning on screen. It is a vector, so it cannot
        // share the scalar's colour-mapped path at all.
        self.sample_vectors();

        self.frame += 1;
        Ok(Some(&self.values))
    }

    /// The velocity at each element's centroid, for the frame just produced.
    fn sample_vectors(&mut self) {
        let n_modes = self.reference.n_modes();
        let centre = self.reference.volume_basis(0);
        let _ = n_modes;

        for element in 0..self.mesh.n_elements() {
            // Evaluated at the first volume quadrature point rather than at the
            // centroid proper: the basis is already tabulated there, and at the
            // scale an arrow is drawn the difference is far below a pixel.
            let state = self.state.evaluate_with(element, centre);
            let [u, v] = self.gas.velocity(&state);
            self.vectors[element * 2] = if u.is_finite() { u as f32 } else { 0.0 };
            self.vectors[element * 2 + 1] = if v.is_finite() { v as f32 } else { 0.0 };
        }
    }

    /// The velocity field of the frame just produced.
    pub fn frame_vectors(&self) -> &[f32] {
        &self.vectors
    }

    /// The extremes of the most recently sampled frame.
    pub fn frame_extremes(&self) -> (f32, f32) {
        self.values
            .iter()
            .fold((f32::INFINITY, f32::NEG_INFINITY), |(low, high), &value| {
                (low.min(value), high.max(value))
            })
    }

    fn step_to(&mut self, target: f64) -> Result<(), String> {
        // Rebuilt per frame rather than held: see the module documentation.
        let conditions: Vec<&dyn BoundaryCondition<4>> = self
            .owned
            .iter()
            .map(|condition| condition as &dyn BoundaryCondition<4>)
            .collect();
        // A purely hyperbolic equation reports no diffusivity, so the interface
        // penalty is already zero -- but it is a conditioning device for a
        // conjugate-gradient solve that does not happen here, and stating that
        // is clearer than relying on the multiplication.
        let mut operator = LdgOperator::with_penalty(
            &self.mesh,
            &self.reference,
            &self.gas,
            &self.map,
            conditions,
            0.0,
        );

        let mut slope = SlopeLimiter::<4>::new(&self.mesh, &self.reference, self.limiter);
        let mut positivity = PositivityLimiter::<4>::new(&self.reference);
        let gas = self.gas;
        let mut lost = 0usize;
        let mut limit = |coefficients: &mut [f64]| {
            slope.apply(coefficients);
            positivity.apply(coefficients, &gas);
            lost += positivity.unrecoverable();
        };

        let options = TransientOptions {
            start_time: self.time,
            end_time: target,
            cfl: self.cfl,
            frames: 2,
            max_steps: MAX_STEPS_PER_FRAME,
            fixed_step: None,
        };

        let state = std::mem::replace(&mut self.state, Solution::<4>::zeros(0, 0));
        let (state, report) =
            solve_transient(&mut operator, state, &options, &mut limit, |_, _, _| {});
        self.state = state;

        self.time = report.time;
        self.steps += report.steps;
        self.smallest_step = self.smallest_step.min(report.smallest_step);
        self.blew_up = report.blew_up;
        self.hit_step_cap = report.hit_step_cap;
        self.unrecoverable += lost;

        if report.blew_up {
            return Err(format!(
                "the run went unstable at t = {:.4}. Lower the CFL fraction, refine the mesh, \
                 or lower the polynomial degree.",
                report.time
            ));
        }
        if report.hit_step_cap {
            return Err(format!(
                "a single frame needed more than {MAX_STEPS_PER_FRAME} steps. The wave speeds \
                 are far out of proportion to the geometry: shorten the end time, coarsen the \
                 mesh, or lower the pressure ratio."
            ));
        }
        Ok(())
    }
}

/// The scalar drawn, from a conserved state.
fn derive(gas: &Euler, field: DerivedField, state: &[f64; 4]) -> f64 {
    match field {
        DerivedField::Density => state[0],
        DerivedField::Pressure => gas.pressure(state),
        DerivedField::Energy => state[3],
        DerivedField::Temperature => {
            gas.pressure(state) / ((gas.gamma - 1.0) * state[0])
        }
        DerivedField::Speed => {
            let [u, v] = gas.velocity(state);
            u.hypot(v)
        }
        DerivedField::Mach => gas.mach(state),
    }
}

#[cfg(test)]
mod fixtures {
    use super::*;
    use crate::{build_mesh, MeshRequest};

    pub fn unit_square() -> Vec<[f64; 2]> {
        vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]
    }

    pub fn segments_of(loop_points: &[[f64; 2]]) -> Vec<f64> {
        let mut segments = Vec::with_capacity(loop_points.len() * 4);
        for (index, &[x, y]) in loop_points.iter().enumerate() {
            let [nx, ny] = loop_points[(index + 1) % loop_points.len()];
            segments.extend_from_slice(&[x, y, nx, ny]);
        }
        segments
    }

    pub fn blast_request() -> TransientRequest {
        let outline = unit_square();
        let mesh = build_mesh(MeshRequest {
            boundary: outline.clone(),
            holes: Vec::new(),
            min_angle_deg: 25.0,
            max_area: Some(0.004),
            max_steps: None,
            max_triangles: None,
        })
        .expect("the unit square meshes");

        TransientRequest {
            vertices: mesh.vertices,
            triangles: mesh.triangles,
            segments: segments_of(&outline),
            segment_tags: vec![0; outline.len()],
            conditions: vec![GasConditionSpec::SlipWall],
            initial: InitialSpec::Blast {
                centre: [0.5, 0.5],
                radius: 0.15,
                inside: GasState {
                    density: 10.0,
                    velocity: [0.0, 0.0],
                    pressure: 10.0,
                },
                outside: GasState {
                    density: 1.0,
                    velocity: [0.0, 0.0],
                    pressure: 1.0,
                },
            },
            gamma: 1.4,
            degree: 1,
            end_time: 0.05,
            frames: 4,
            cfl: 0.3,
            limiter: 0.0,
            subdivisions: 2,
            field: DerivedField::Density,
        }
    }
}

#[cfg(test)]
mod running {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn a_blast_produces_every_frame_it_promised() {
        let mut run = TransientRun::start(blast_request()).expect("a valid request");
        let setup_frames = run.setup.frames;
        // Read before the loop: a frame borrows the run for as long as it is
        // held, which is the point -- the values are the run's own buffer, not a
        // copy of it.
        let expected = run.setup.element_count * run.setup.sample_stride;
        assert_eq!(setup_frames, 4);

        let mut produced = 0;
        while let Some(values) = run.advance_frame().expect("the run holds together") {
            assert_eq!(values.len(), expected);
            assert!(values.iter().all(|value| value.is_finite()));
            produced += 1;
        }

        assert_eq!(produced, setup_frames);
        assert_eq!(run.remaining(), 0);
        assert!(run.advance_frame().expect("a finished run").is_none());
        assert!(!run.blew_up);
        assert_eq!(run.unrecoverable, 0);
    }

    /// The first frame is the initial condition and must not have been stepped.
    /// A run that stepped before its first frame would never show the state the
    /// user asked for.
    #[test]
    fn the_first_frame_is_the_initial_condition() {
        let mut run = TransientRun::start(blast_request()).expect("a valid request");
        run.advance_frame().expect("the first frame").expect("a frame");

        assert_eq!(run.steps, 0, "the run stepped before its first frame");
        assert_eq!(run.time, 0.0);

        // The blast is 10 inside and 1 outside, so the density spans that.
        let (low, high) = run.frame_extremes();
        assert!(low <= 1.05, "the outside state is missing; lowest is {low}");
        assert!(high >= 9.0, "the inside state is missing; highest is {high}");
    }

    /// Positions never change, so they cross once and the per-frame payload is
    /// values alone.
    /// Each schedule does what its name says at the times that matter.
    #[test]
    fn every_schedule_runs_between_ambient_and_its_target() {
        assert_eq!(InflowSchedule::Steady.factor(0.0), 1.0);
        assert_eq!(InflowSchedule::Steady.factor(99.0), 1.0);

        let ramp = InflowSchedule::Ramp { over: 2.0 };
        assert_eq!(ramp.factor(0.0), 0.0);
        assert_eq!(ramp.factor(1.0), 0.5);
        assert_eq!(ramp.factor(2.0), 1.0);
        assert_eq!(ramp.factor(99.0), 1.0, "a ramp holds once it has arrived");

        let pulse = InflowSchedule::Pulse { start: 1.0, end: 2.0 };
        assert_eq!(pulse.factor(0.5), 0.0);
        assert_eq!(pulse.factor(1.5), 1.0);
        assert_eq!(pulse.factor(2.5), 0.0);

        let wave = InflowSchedule::Oscillation { period: 4.0 };
        assert!(wave.factor(0.0).abs() < 1e-12);
        assert!((wave.factor(2.0) - 1.0).abs() < 1e-12);
        // And it stays inside the two states it interpolates between.
        for step in 0..40 {
            let factor = wave.factor(step as f64 * 0.1);
            assert!((-1e-12..=1.0 + 1e-12).contains(&factor), "factor {factor}");
        }
    }

    /// The velocity field is its own payload, one vector per element, and it is
    /// anchored by a static origin list that crosses once per run.
    #[test]
    fn the_velocity_field_carries_one_vector_per_element() {
        let mut run = TransientRun::start(blast_request()).expect("a valid request");
        let elements = run.setup.element_count;
        assert_eq!(run.vector_origins.len(), elements * 2);

        run.advance_frame().expect("a frame").expect("a frame");
        // A blast starts at rest, so the first frame's velocity is zero.
        assert_eq!(run.frame_vectors().len(), elements * 2);
        assert!(run.frame_vectors().iter().all(|&value| value.abs() < 1e-9));

        // By a later frame the gas is moving, and outward.
        for _ in 0..3 {
            run.advance_frame().expect("a frame");
        }
        let fastest = run
            .frame_vectors()
            .iter()
            .fold(0.0f32, |worst, &value| worst.max(value.abs()));
        assert!(fastest > 1e-3, "the blast never moved: fastest {fastest}");
        assert!(run.frame_vectors().iter().all(|value| value.is_finite()));
    }

    /// Energy and temperature are separate scalars, and neither is the density.
    #[test]
    fn the_scalar_menu_distinguishes_energy_from_the_rest() {
        let gas = Euler::air();
        let state = gas.conserved(&Primitive {
            density: 2.0,
            velocity: [3.0, 4.0],
            pressure: 5.0,
        });

        assert_eq!(derive(&gas, DerivedField::Density, &state), 2.0);
        assert!((derive(&gas, DerivedField::Pressure, &state) - 5.0).abs() < 1e-12);
        assert!((derive(&gas, DerivedField::Speed, &state) - 5.0).abs() < 1e-12);
        // E = p/(g-1) + rho|v|^2/2 = 12.5 + 25 = 37.5
        assert!((derive(&gas, DerivedField::Energy, &state) - 37.5).abs() < 1e-12);
        // e = p / ((g-1) rho) = 5 / (0.4 * 2) = 6.25
        assert!((derive(&gas, DerivedField::Temperature, &state) - 6.25).abs() < 1e-12);
    }

    #[test]
    fn the_positions_carry_two_coordinates_for_every_sampled_value() {
        let run = TransientRun::start(blast_request()).expect("a valid request");
        assert_eq!(
            run.positions.len(),
            2 * run.setup.element_count * run.setup.sample_stride
        );
    }

    /// A wall must reflect. With walls all round and no source, the mass is
    /// fixed, so the density's mean over the sample lattice cannot drift far --
    /// and a wall that had silently become transparent would let the blast out.
    #[test]
    fn a_walled_box_keeps_its_gas() {
        let mut request = blast_request();
        request.frames = 6;
        request.end_time = 0.15;
        let mut run = TransientRun::start(request).expect("a valid request");

        let mut means = Vec::new();
        while let Some(values) = run.advance_frame().expect("the run holds together") {
            let sum: f64 = values.iter().map(|&value| value as f64).sum();
            means.push(sum / values.len() as f64);
        }

        let first = means[0];
        for (frame, mean) in means.iter().enumerate() {
            assert!(
                (mean - first).abs() < 0.05 * first,
                "frame {frame} has a mean density of {mean} against {first} at the start; \
                 gas is leaving a closed box"
            );
        }
    }

    /// Every derived scalar stays in the range its own physics allows.
    ///
    /// The bounds are only what physics demands, not what the blast happens to
    /// do: an expanding blast rarefies its own interior, so the pressure drops
    /// well below the ambient value it started from. Asserting anything tighter
    /// would be asserting a guess about the solution.
    #[test]
    fn each_derived_field_stays_within_its_physical_range() {
        for field in [
            DerivedField::Density,
            DerivedField::Pressure,
            DerivedField::Speed,
            DerivedField::Mach,
        ] {
            let mut request = blast_request();
            request.field = field;
            let mut run = TransientRun::start(request).expect("a valid request");
            run.advance_frame().expect("a frame").expect("a frame");
            run.advance_frame().expect("a frame").expect("a frame");

            let (low, high) = run.frame_extremes();
            // Density and pressure must be positive; a speed and a Mach number
            // are magnitudes and cannot be negative either.
            assert!(low > 0.0 || matches!(field, DerivedField::Speed | DerivedField::Mach),
                "{field:?} went down to {low}");
            assert!(low >= 0.0, "{field:?} went negative at {low}");
            assert!(high.is_finite() && high > low, "{field:?} spans {low} to {high}");
        }
    }
}

#[cfg(test)]
mod rejected_requests {
    use super::fixtures::*;
    use super::*;

    fn rejected(mutate: impl FnOnce(&mut TransientRequest)) -> String {
        let mut request = blast_request();
        mutate(&mut request);
        match TransientRun::start(request) {
            Ok(_) => panic!("the request was accepted"),
            Err(error) => error,
        }
    }

    #[test]
    fn a_non_positive_back_pressure_is_rejected() {
        let message = rejected(|request| {
            request.conditions = vec![GasConditionSpec::Outflow { pressure: 0.0 }];
        });
        assert!(message.contains("back pressure"), "{message}");
    }

    #[test]
    fn an_inflow_with_an_inadmissible_state_is_rejected() {
        let message = rejected(|request| {
            request.conditions = vec![GasConditionSpec::Inflow {
                state: GasState {
                    density: -1.0,
                    velocity: [1.0, 0.0],
                    pressure: 1.0,
                },
                schedule: InflowSchedule::Steady,
            }];
        });
        assert!(message.contains("density"), "{message}");
    }

    #[test]
    fn a_ramp_with_no_duration_is_rejected() {
        let message = rejected(|request| {
            request.conditions = vec![GasConditionSpec::Inflow {
                state: GasState {
                    density: 1.0,
                    velocity: [3.0, 0.0],
                    pressure: 1.0,
                },
                schedule: InflowSchedule::Ramp { over: 0.0 },
            }];
        });
        assert!(message.contains("ramp"), "{message}");
    }

    #[test]
    fn a_pulse_that_ends_before_it_starts_is_rejected() {
        let message = rejected(|request| {
            request.conditions = vec![GasConditionSpec::Inflow {
                state: GasState {
                    density: 1.0,
                    velocity: [3.0, 0.0],
                    pressure: 1.0,
                },
                schedule: InflowSchedule::Pulse { start: 2.0, end: 1.0 },
            }];
        });
        assert!(message.contains("pulse"), "{message}");
    }

    #[test]
    fn a_ratio_of_specific_heats_at_one_is_rejected() {
        assert!(rejected(|request| request.gamma = 1.0).contains("specific heats"));
    }

    #[test]
    fn a_negative_initial_pressure_is_rejected() {
        let message = rejected(|request| {
            if let InitialSpec::Blast { inside, .. } = &mut request.initial {
                inside.pressure = -1.0;
            }
        });
        assert!(message.contains("pressure"), "{message}");
    }

    #[test]
    fn a_zero_initial_density_is_rejected() {
        let message = rejected(|request| {
            if let InitialSpec::Blast { outside, .. } = &mut request.initial {
                outside.density = 0.0;
            }
        });
        assert!(message.contains("density"), "{message}");
    }

    #[test]
    fn a_blast_with_no_radius_is_rejected() {
        let message = rejected(|request| {
            if let InitialSpec::Blast { radius, .. } = &mut request.initial {
                *radius = 0.0;
            }
        });
        assert!(message.contains("radius"), "{message}");
    }

    #[test]
    fn a_non_positive_end_time_is_rejected() {
        assert!(rejected(|request| request.end_time = 0.0).contains("end time"));
    }

    #[test]
    fn a_cfl_fraction_above_one_is_rejected() {
        assert!(rejected(|request| request.cfl = 1.5).contains("CFL"));
    }

    #[test]
    fn a_single_frame_is_rejected() {
        assert!(rejected(|request| request.frames = 1).contains("frames"));
    }

    #[test]
    fn too_many_frames_are_rejected() {
        assert!(rejected(|request| request.frames = MAX_FRAMES + 1).contains("frames"));
    }

    #[test]
    fn a_degree_above_the_ceiling_is_rejected() {
        assert!(rejected(|request| request.degree = MAX_DEGREE + 1).contains("degree"));
    }

    #[test]
    fn a_negative_limiter_constant_is_rejected() {
        assert!(rejected(|request| request.limiter = -1.0).contains("limiter"));
    }

    #[test]
    fn a_segment_tagged_past_the_condition_table_is_rejected() {
        assert!(rejected(|request| request.segment_tags[0] = 7).contains("tagged"));
    }

    #[test]
    fn a_request_with_no_conditions_is_rejected() {
        assert!(rejected(|request| request.conditions.clear()).contains("boundary conditions"));
    }

    /// An oversized problem is refused rather than attempted, in the idiom the
    /// steady path already uses: the message names the knob to turn.
    #[test]
    fn an_oversized_problem_is_refused_rather_than_attempted() {
        let message = rejected(|request| {
            let elements = MAX_DEGREES_OF_FREEDOM;
            request.triangles = vec![0; elements * 3];
            request.vertices = vec![0.0; 8];
            request.degree = 3;
        });
        assert!(message.contains("ceiling"), "{message}");
        assert!(
            message.contains("element area") || message.contains("degree"),
            "the refusal should name a knob: {message}"
        );
    }
}

#[cfg(test)]
mod wire_format {
    use super::*;

    /// The tagged JSON both sides must agree on. Pinned here because the web
    /// app writes these by hand in TypeScript and nothing else would catch a
    /// rename.
    #[test]
    fn the_condition_kinds_are_internally_tagged() {
        assert_eq!(
            serde_json::to_string(&GasConditionSpec::SlipWall).unwrap(),
            r#"{"kind":"slip_wall"}"#
        );
        assert_eq!(
            serde_json::to_string(&GasConditionSpec::Transmissive).unwrap(),
            r#"{"kind":"transmissive"}"#
        );

        let inflow = GasConditionSpec::SupersonicInflow {
            state: GasState {
                density: 1.0,
                velocity: [2.0, 0.0],
                pressure: 1.0,
            },
        };
        let json = serde_json::to_string(&inflow).unwrap();
        assert!(json.starts_with(r#"{"kind":"supersonic_inflow""#), "{json}");
        assert_eq!(
            serde_json::from_str::<GasConditionSpec>(&json).unwrap(),
            inflow
        );
    }

    #[test]
    fn the_initial_kinds_are_internally_tagged() {
        let blast = InitialSpec::Blast {
            centre: [0.5, 0.5],
            radius: 0.2,
            inside: GasState {
                density: 10.0,
                velocity: [0.0, 0.0],
                pressure: 10.0,
            },
            outside: GasState {
                density: 1.0,
                velocity: [0.0, 0.0],
                pressure: 1.0,
            },
        };
        let json = serde_json::to_string(&blast).unwrap();
        assert!(json.starts_with(r#"{"kind":"blast""#), "{json}");
        assert_eq!(serde_json::from_str::<InitialSpec>(&json).unwrap(), blast);

        let riemann = InitialSpec::Riemann {
            normal: [1.0, 0.0],
            position: 0.5,
            left: GasState {
                density: 1.0,
                velocity: [0.0, 0.0],
                pressure: 1.0,
            },
            right: GasState {
                density: 0.125,
                velocity: [0.0, 0.0],
                pressure: 0.1,
            },
        };
        let json = serde_json::to_string(&riemann).unwrap();
        assert!(json.starts_with(r#"{"kind":"riemann""#), "{json}");
        assert_eq!(serde_json::from_str::<InitialSpec>(&json).unwrap(), riemann);
    }

    #[test]
    fn the_new_condition_kinds_are_internally_tagged() {
        assert_eq!(
            serde_json::to_string(&GasConditionSpec::Outflow { pressure: 1.5 }).unwrap(),
            r#"{"kind":"outflow","pressure":1.5}"#
        );

        let inflow = GasConditionSpec::Inflow {
            state: GasState {
                density: 1.0,
                velocity: [3.0, 0.0],
                pressure: 1.0,
            },
            schedule: InflowSchedule::Ramp { over: 2.0 },
        };
        let json = serde_json::to_string(&inflow).unwrap();
        assert!(json.starts_with(r#"{"kind":"inflow""#), "{json}");
        assert_eq!(serde_json::from_str::<GasConditionSpec>(&json).unwrap(), inflow);
    }

    #[test]
    fn a_schedule_defaults_to_steady_when_it_is_left_out() {
        let spec: GasConditionSpec = serde_json::from_str(
            r#"{"kind":"inflow","state":{"density":1,"velocity":[3,0],"pressure":1}}"#,
        )
        .expect("an inflow without a schedule parses");
        assert_eq!(
            spec,
            GasConditionSpec::Inflow {
                state: GasState {
                    density: 1.0,
                    velocity: [3.0, 0.0],
                    pressure: 1.0
                },
                schedule: InflowSchedule::Steady,
            }
        );
    }

    #[test]
    fn the_derived_fields_are_plain_strings() {
        assert_eq!(
            serde_json::to_string(&DerivedField::Mach).unwrap(),
            r#""mach""#
        );
        assert_eq!(
            serde_json::to_string(&DerivedField::Speed).unwrap(),
            r#""speed""#
        );
    }

    /// Everything with a default really does default, so the web app can send a
    /// minimal request.
    #[test]
    fn the_optional_request_fields_all_default() {
        let request: TransientRequest = serde_json::from_str(
            r#"{
                "vertices": [0.0, 0.0],
                "triangles": [0, 0, 0],
                "segments": [],
                "segment_tags": [],
                "conditions": [{"kind": "slip_wall"}],
                "initial": {"kind": "uniform", "state":
                    {"density": 1.0, "velocity": [0.0, 0.0], "pressure": 1.0}},
                "end_time": 1.0
            }"#,
        )
        .expect("a minimal request parses");

        assert_eq!(request.gamma, 1.4);
        assert_eq!(request.degree, 1);
        assert_eq!(request.frames, 60);
        assert_eq!(request.cfl, 0.3);
        assert_eq!(request.limiter, 0.0);
        assert_eq!(request.subdivisions, 2);
        assert_eq!(request.field, DerivedField::Density);
    }
}
