# FEA Online

Browser-based finite element tool. Draw geometry, mesh it, and (later) solve on
it — all client-side, with the mesher compiled to WebAssembly.

Phase 1 is the mesher: draw a boundary and holes, refine to a quality target,
and iterate on the result interactively.

## Layout

```
fea-online/
├── apps/web/              Next.js UI — canvas, controls, worker
├── crates/
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

## Known issue

The mesher has a hash-order-dependent unbounded allocation in its
segment-recovery path: the same request succeeds roughly 27 times out of 28 and
then tries to allocate 512 MB in one go. Only reflex (notched) geometry triggers
it; convex boundaries with holes are stable over hundreds of repeats.

Ruled out with evidence: not a leak (live bytes stay flat), not the refinement
caps (the blow-up is one allocation inside a single step), not any particular
geometry or angle (each passes in isolation). What remains is `HashSet`
iteration order — refinement's triangle selection was made order-independent,
but `insert_segments`, `unencroach` and the polyline boolean helpers were not.

Reproduce by un-ignoring `known_issues::repeated_identical_requests_are_stable`
in `crates/fea-wasm`. Fix this before adding sharp-corner handling, which lives
in the same code.
