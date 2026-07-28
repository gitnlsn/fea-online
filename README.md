# FEA Online

Browser-based finite element tool. Draw geometry, mesh it, and solve on it — all
client-side, with the mesher and the solver compiled to WebAssembly.

Phase 1 is the mesher: draw a boundary and holes, refine to a quality target,
and iterate on the result interactively.

Phase 2 is the solver, and is wired to the UI. `crates/fea-dg` is a
discontinuous Galerkin solver for a generic conservation equation on triangles,
and it implements two of them. **Steady scalar diffusion** solves
`-∇·(k∇u) = s` on the drawn domain. Attach a fixed value, a fixed flux or a
convective condition to each loop — or to an individual edge, by clicking it —
press Solve, and the field is drawn on the canvas against a legend. The viewport
switches between the plan and a 3D surface, where the field is the height over
the mesh you drew — see [Reading the field](#reading-the-field).

**Transient compressible Euler** solves for air: set a blast off inside the
domain and watch the shock expand, reflect off the walls you drew and diffract
around the holes, then scrub or play back through it. See
[Shock waves](#shock-waves).

## Layout

```
fea-online/
├── apps/web/              Next.js UI — canvas, controls, worker
├── crates/
│   ├── fea-dg/            submodule → gitnlsn/fea-dg, the DG solver
│   ├── fea-wasm/          wasm-bindgen surface over the mesher and the solver
│   └── nlsn-delaunay/     submodule → gitnlsn/nlsn-delaunay-refine
└── scripts/build-wasm.sh  builds the mesher to wasm
```

`crates/nlsn-delaunay` is a **submodule**, not part of this repo. It is a
standalone constrained-Delaunay mesher published to crates.io, so fixes to it
belong in its own history and can be released independently.

## Getting started

```sh
git clone --recurse-submodules <this repo>
pnpm install
pnpm dev
```

If you cloned without `--recurse-submodules`:

```sh
git submodule update --init
```

The wasm package is **generated, not committed** (`apps/web/wasm/` and
`apps/web/public/fea_wasm_bg.wasm` are gitignored). `pnpm dev` and `pnpm build`
run `build:wasm` first, so a fresh clone works — but running `next dev` directly
will fail until you have run `pnpm build:wasm` at least once.

`scripts/build-wasm.sh` installs a Rust toolchain if `cargo` is missing, which
is what lets this build on Vercel, where the image has no Rust.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Build wasm, then run the Next dev server |
| `pnpm build` | Build wasm, then build the app |
| `pnpm build:wasm` | Rebuild the wasm package only |
| `pnpm test` | Rust tests, then frontend tests |
| `pnpm test:rust` | `cargo test --release -- --test-threads=1` |
| `pnpm test:web` | Node's test runner over `apps/web/lib` |

Rust tests run single-threaded on purpose: several mesh large domains, and
running them concurrently multiplies peak memory for no benefit.

## Working on the mesher

`crates/nlsn-delaunay` is an independent checkout. Commit and push there as
normal, then record the new pointer here:

```sh
cd crates/nlsn-delaunay && git commit -am "..." && git push
cd ../.. && git add crates/nlsn-delaunay && git commit -m "bump mesher"
```

The outer repo pins an exact mesher commit, so the app always builds against a
known-good version rather than whatever is currently checked out.

## Solver

`crates/fea-dg` solves

```
∂u/∂t + ∇·J(u, ∇u, x) = s
```

where the caller supplies `J`. Choosing it recovers the equation: `J = -k∇u` is
diffusion, whose steady state is Poisson; `J = a·u` is linear advection; and the
compressible Euler flux over `(ρ, ρu, ρv, E)` is the same trait at `N = 4`.
Solid stress–strain is not implemented yet; the trait is shaped so it is an
addition rather than a rewrite.

An equation states its flux in two halves — advective and diffusive — because
the face term needs them separately. A diffusive flux is taken wholly from one
side, the LDG alternating choice; an advective one is upwinded, because
information along a characteristic travels one way and averaging it is
unconditionally unstable. Boundaries follow the same split: the elliptic
conditions are the `αu + β(J·n) = g` relation, and the hyperbolic ones are
**ghost states** — a slip wall is the interior with its normal velocity
reversed, which no choice of `α` and `β` can express.

The discretisation is LDG — the auxiliary variable `q = ∇u` is recovered by the
same weak form as `u`, so advective and diffusive fluxes share one code path —
on an orthonormal modal (Dubiner) basis over straight-sided triangles. That
combination makes the mass matrix `detJ·I`, so the steady problem is solved by
matrix-free conjugate gradient with **no linear algebra dependency at all**. The
crate's only dependency is the mesher, and it still builds for
`wasm32-unknown-unknown`.

Measured order of accuracy on `-∇²u = 2π²sin(πx)sin(πy)`, over mesher-generated
unstructured meshes:

| p | L2 rate | H1 rate |
|---|---|---|
| 1 | 1.98 | 1.01 |
| 2 | 3.06 | 2.04 |
| 3 | 3.98 | 3.01 |

which is the optimal `O(h^{p+1})` and `O(h^p)`. On the L-shaped domain the
re-entrant corner correctly caps both at 2/3 and 4/3 for every degree.

Run `cargo test --release -p fea-dg -- --nocapture` to print the convergence
tables.

### How it reaches the browser

`crates/fea-wasm` exports `solve(request)` beside `mesh(request)`, and the web
app drives it from its own worker so a solve cannot block a remesh. The request
carries the mesh arrays the UI already holds — rather than re-meshing inside the
solver, which could put the field on a mesh the user is not looking at — plus
the drawn edges and a condition per edge.

Three things in that path are worth knowing about:

- **Boundary conditions are matched geometrically.** Neither `FlatMesh` nor the
  wasm mesh response carries markers, so `crates/fea-wasm/src/classify.rs`
  assigns each boundary face the tag of the input segment it lies on. This is
  exact rather than approximate: refinement only ever *splits* an input segment,
  at that segment's own midpoint, so a face sits on its own segment to within
  round-off and some ten orders of magnitude closer than to any other.
- **The field is sampled, not interpolated.** The solver's output is Dubiner
  modal coefficients, and a discontinuous field has no single value at a shared
  node — averaging to get one would smooth away the jumps the method exists to
  represent. `sample.rs` evaluates each element on its own barycentric lattice
  and emits its own copy of every point, which is also what makes a `p > 1`
  basis visible instead of being flattened to one colour per element.
- **Everything that could trip an assertion is rejected first.** A panic inside
  wasm aborts the instance and takes the worker with it, so a bad number would
  leave the UI permanently unable to solve rather than showing a message. The
  checks in `solve.rs` mirror the solver's own `assert!`s one for one.

Two results the solver reports that the picture cannot show, and which the UI
therefore states in words: an iteration that hit its cap still returns its best
iterate, and a problem with no prescribed value anywhere is fixed only up to a
constant — and, if its fluxes do not balance its source, has no solution at all
while still returning a plausible-looking one.

### Shock waves

Pick **Air** at the top of the sidebar and the app solves compressible Euler on
the drawn domain instead of diffusion. The two studies do not share a panel
between them: in Air there is no conductivity on screen, because there is no
conductivity in the problem.

Choose a blast, a shock tube or still air; say what is outside each boundary —
per loop, or per edge by clicking the drawing, exactly as the diffusion study's
conditions are assigned; press Run, and scrub or play the result.

Four boundary conditions, and the solver picks the regime rather than the user:

| | |
|---|---|
| **Wall** | reflects; the ghost is the interior with its normal velocity reversed |
| **Open** | extrapolates everything. Exact only above Mach 1 |
| **Inflow** | a state, imposed in full when supersonic and less its pressure when not |
| **Outflow** | a back pressure, non-reflecting when subsonic and transparent when not |

`Inflow` and `Outflow` decide per face, from the flow itself, how many of the
four characteristics are entering and therefore how many components may be
imposed. A user who had to choose correctly between "supersonic inflow" and
"subsonic inflow" would be being asked for the answer before the run.

The gain from `Outflow` over `Open` is measured, not asserted: an acoustic pulse
leaving a subsonic boundary leaves **2.8× less** behind it
(`a_subsonic_outflow_reflects_less_than_a_transmissive_one`). It also anchors the
pressure level, which plain extrapolation cannot — with nothing prescribed there
is nothing to hold it.

**Velocity is drawn as arrows, not as a colour.** It is a vector, and a colour
map has nowhere to put a direction, so colouring by `|v|` alone throws away most
of what the field says. The arrows sit over whichever scalar is coloured —
density, pressure, total or internal energy, speed or Mach number — and are
thinned to a roughly fixed count on screen rather than in the data, since how
many fit is a property of the zoom and not of the mesh.

Each boundary edge is stroked by what is assigned to it, colour **and** dash. The
stylesheet defines one categorical hue and reserves the status colours for things
"only ever shown alongside an explicit count + label", so meaning that rested on
hue alone would be both unavailable and against the grain of the file.

Four choices are worth knowing about.

- **The state is conserved variables, never primitive ones.** A conservation
  law's weak form is only a conservation law in `(ρ, ρu, ρv, E)`; integrating
  the primitive form across a shock gives the wrong jump conditions, so a scheme
  written in pressure and velocity converges smoothly and confidently to a shock
  moving at the **wrong speed**. `tests/euler_sod.rs` is the only test that can
  catch that, which is why it compares against an exact Riemann solution rather
  than measuring a rate.
- **Limiting is not optional.** At a strong pressure ratio an unlimited
  high-order reconstruction reaches negative pressure, the sound speed becomes
  the square root of a negative number, and the whole field is `NaN` within a
  few steps. Two passes run after every Runge-Kutta stage: a slope limiter
  against the neighbouring cell averages, and a Zhang-Shu pass that keeps
  density and pressure positive at every point a flux is evaluated. That the
  second is load-bearing is asserted, not assumed —
  `the_same_blast_without_positivity_limiting_does_not_survive`.
- **A higher degree does not pay off across a shock.** The slope limiter scales
  every mode above the constant by one factor, so an element it touches is
  reduced to a straight line whatever its degree — and across a shock it touches
  most of them. Measured on a fixed shock tube, `p = 2` is half again *worse*
  than `p = 1` for nearly twice the work. A hierarchical limiter, which limits
  mode by mode, would fix it and is not implemented.
- **The run is pulled a frame at a time.** A steady solve is one call; a
  transient run is thousands of steps producing sixty fields. Returning them in
  one call would mean no progress, no cancellation, and every frame held in Rust
  and in JavaScript at once. So the worker holds a `TransientRun` and asks it for
  frames, positions cross once because they never change, and the bulk payload
  is a real `Float32Array` rather than the boxed `Array` that
  `serde_wasm_bindgen` would produce.

The colour range spans the **whole run**, not each frame. A per-frame range
would rescale the ramp on every tick, so a decaying blast would read as a field
of constant intensity moving through a changing colour scheme — the opposite of
what the animation is for.

### Reading the field

The field is drawn two ways, and the 2D/3D switch in the corner of the viewport
picks between them. In plan it is a colour map over the mesh; in 3D it is a
surface, with the drawing on the ground plane and the field as height.

The surface is the better picture of a DG solution, because a colour ramp can
say *where* the field is high but not *by how much*, and it hides the
inter-element jumps: a discontinuity that reads as two adjacent shades of orange
in plan is a visible step in a surface. Watching those steps close as the degree
rises is the clearest picture of convergence the tool gives.

- **Raw WebGL2, no dependency.** A field at a few thousand elements is tens of
  thousands of sub-triangles and orbiting repaints all of them per frame, which
  is well past what filling canvas paths can do. But the sampled field is
  already a triangle soup and the shading is one cross product of screen-space
  derivatives, so the renderer is a shader pair (`components/SurfaceCanvas.tsx`)
  over three small modules: `lib/mat4.ts`, `lib/orbit.ts`, `lib/surface.ts`.
- **The buffer is non-indexed, for the same reason the sampler duplicates
  points.** Welding the shared edges, or averaging at shared nodes, would smooth
  away exactly what the surface exists to show.
- **One set of ramp stops.** `lib/fieldRamp.ts` is shared by the 2D fill, the
  legend and the shader rather than transcribed into GLSL, and the shader steps
  it with the same arithmetic, so all three land on the same colour for the same
  value.
- **The vertical axis is not to scale and is not labelled.** Height is fitted to
  the plan rather than to the field's own units, so a plate held at 100 and the
  same plate at conductivity 1000 both open readable. The legend has the
  numbers; the surface has the shape.
