# FEA Online

Browser-based finite element tool. Draw geometry, mesh it, and (later) solve on
it — all client-side, with the mesher compiled to WebAssembly.

Phase 1 is the mesher: draw a boundary and holes, refine to a quality target,
and iterate on the result interactively.

Phase 2 is the solver, and has started. `crates/fea-dg` is a discontinuous
Galerkin solver for a generic conservation equation on triangles. It is not yet
wired to the UI.

## Layout

```
fea-online/
├── apps/web/              Next.js UI — canvas, controls, worker
├── crates/
│   ├── fea-dg/            discontinuous Galerkin solver over the mesh
│   ├── fea-wasm/          wasm-bindgen surface over the mesher
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
