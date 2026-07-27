# FEA Online

Browser-based finite element tool. Draw geometry, mesh it, and solve on it — all
client-side, with the mesher and the solver compiled to WebAssembly.

Phase 1 is the mesher: draw a boundary and holes, refine to a quality target,
and iterate on the result interactively.

Phase 2 is the solver, and is wired to the UI. `crates/fea-dg` is a
discontinuous Galerkin solver for a generic conservation equation on triangles;
what it implements today is **steady scalar diffusion**, so the tool solves
`-∇·(k∇u) = s` on the drawn domain. Attach a fixed value, a fixed flux or a
convective condition to each loop — or to an individual edge, by clicking it —
press Solve, and the field is drawn on the canvas against a legend.

Transient and vector problems are solver work, not UI work: see
[Solver](#solver) for what the trait does and does not cover yet.

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
diffusion, and its steady state is Poisson. The transient hyperbolic path
(`J = a·u`, explicit time stepping) and solid stress–strain are not implemented
yet; the trait is shaped so they are additions rather than a rewrite.

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
