#!/usr/bin/env bash
#
# Builds the Rust mesher to WebAssembly and places it where the Next.js app
# expects it.
#
# Runs both locally and in CI/Vercel. On Vercel the build image has no Rust
# toolchain, so this installs one when cargo is missing -- see the note on
# wasm-pack below for why it is fetched as a prebuilt binary rather than built
# from source.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/apps/web/wasm"
PUBLIC_DIR="$ROOT/apps/web/public"

export PATH="$HOME/.cargo/bin:$PATH"

if ! command -v cargo >/dev/null 2>&1; then
  echo "==> cargo not found; installing Rust toolchain"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable
  export PATH="$HOME/.cargo/bin:$PATH"
fi

echo "==> ensuring wasm32-unknown-unknown target"
rustup target add wasm32-unknown-unknown

if ! command -v wasm-pack >/dev/null 2>&1; then
  # Deliberately the prebuilt binary rather than `cargo install wasm-pack`:
  # building the CLI from source takes about a minute even with a warm cache,
  # and a cold CI build has no cache at all.
  echo "==> installing wasm-pack"
  curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh
fi

echo "==> building fea-wasm"
cd "$ROOT/crates/fea-wasm"
wasm-pack build \
  --target web \
  --out-dir "$OUT_DIR" \
  --out-name fea_wasm \
  --release

# The worker loads the binary from a plain URL rather than importing it, which
# keeps this independent of how the bundler happens to treat .wasm assets.
echo "==> publishing wasm binary to public/"
mkdir -p "$PUBLIC_DIR"
cp "$OUT_DIR/fea_wasm_bg.wasm" "$PUBLIC_DIR/fea_wasm_bg.wasm"

echo "==> done: $(du -h "$PUBLIC_DIR/fea_wasm_bg.wasm" | cut -f1) wasm binary"
