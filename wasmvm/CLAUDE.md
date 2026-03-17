# WasmVM

## Overview
BusyBox-style WebAssembly binary containing a comprehensive Unix userland, paired with a JavaScript host runtime. Runs identically in browsers and Node.js.

- **Spec (MVP):** `notes/specs/wasmvm-mvp.md`
- **Spec (current work):** `notes/specs/wasmvm-tool-completeness.md`
- **Compatibility matrix:** `docs/compatibility-matrix.md` (keep up to date when adding/replacing commands)
- **Deferred TODOs:** `notes/todo.md`

## Naming
- The project is called **wasmVM**
- The internal component is **WasmCore** — the WASM runtime subsystem
- `wasmvm/crates/` contains Rust workspace crates
- `packages/runtime/wasmvm/` contains the TypeScript host runtime

## Build
- Targets `wasm32-wasip1`
- Uses Rust nightly pinned in `rust-toolchain.toml` (pin to `nightly-2026-03-01` or later)
- Build with `-Z build-std=std,panic_abort` for custom std patches
- Pin the nightly version everywhere possible to avoid breakage
- Build command: `cd wasmvm && make wasm`

## Key Decisions
- **shell:** `brush-shell` (bash 5.x compatible, pure Rust, MIT)
- **sed:** `uutils/sed` (GNU sed compatible, pure Rust)
- **awk:** `awk-rs` (POSIX + gawk extensions, pure Rust, minimal deps)
- **grep:** `ripgrep` (confirmed WASM-compilable, build without PCRE2)
- **jq:** `jaq` (confirmed WASM-compilable, pure Rust)
- **find:** Custom POSIX implementation (fd-find has incompatible CLI)
- Do NOT use `sd`, `frawk`, or `zawk`
- No dependency on WASIX, Wasmer, Emscripten, Wasmtime, or any proprietary runtime

## Why Not Wasmtime / WASI Runtimes
We implement our own WASI host runtime in JavaScript:
1. **Browser compatibility is a hard requirement** — native runtimes don't run in browsers
2. **Existing WASI-in-JS implementations were too buggy** — incomplete syscalls, broken fd management
3. **We need capabilities beyond WASI** — custom `host_process`, `host_user` import modules
4. **Component Model (WIT) is not supported in browsers** — we target core WASM modules

## License
- Apache-2.0 compatible only
- Acceptable: Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC, Unlicense, Zlib, CC0-1.0
- Do NOT import GPL, LGPL, AGPL, or copyleft packages
- Do NOT import GNU tools directly — use permissive reimplementations

## Dependency Patching

### Three tiers (prefer Tier 1, escalate as needed)
1. **Direct dependency** — crate compiles for WASI and exposes `uumain()`. Just add to Cargo.toml.
2. **`cargo vendor` + `.patch`** — vendor source, apply `.patch` files for WASI fixes
3. **Full fork** — extensive changes too large for patches

### Conventions
- Patch files: `patches/crates/<crate-name>/0001-description.patch`
- `scripts/patch-vendor.sh` applies them during `make wasm`
- `vendor/` is gitignored — only `.patch` files are committed
- **stubs/** = replace entire crate behavior (e.g., ctrlc → no-op)
- **patches/crates/** = small surgical changes to otherwise-working crates
