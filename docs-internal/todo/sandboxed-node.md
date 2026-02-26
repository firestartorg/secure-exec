# Sandboxed Node TODOs

- [x] Remove all `@hono/node-server` bridge integration and load it only from sandboxed `node_modules`.
  - Remove bridge module and exports (`packages/sandboxed-node/src/bridge/hono-node-server.ts`, `packages/sandboxed-node/src/bridge/index.ts`).
  - Remove `@hono/node-server` special-cases in runtime resolution/execution (`packages/sandboxed-node/src/index.ts`, `packages/sandboxed-node/src/shared/require-setup.ts`).
  - Remove `honoServe`/`honoClose` from adapter/types if no longer needed (`packages/sandboxed-node/src/types.ts`, `packages/sandboxed-node/src/shared/permissions.ts`, `packages/sandboxed-node/src/node/driver.ts`).

- [x] Implement Node built-in HTTP server bridging (`http.createServer`) without third-party module bridges.
  - Add server listen/close/address request-dispatch bridge hooks in runtime setup (`packages/sandboxed-node/src/index.ts`).
  - Implement server-side compatibility in network bridge (`packages/sandboxed-node/src/bridge/network.ts`).
  - Add Node driver implementation backed by `node:http` (`packages/sandboxed-node/src/node/driver.ts`, `packages/sandboxed-node/src/types.ts`, `packages/sandboxed-node/src/shared/permissions.ts`).

- [x] Expose host-side request path to sandbox servers via `sandbox.network.fetch(...)`.
  - Provide a NodeProcess-level network facade and document concurrent run/fetch pattern (`packages/sandboxed-node/src/index.ts`, `README.md`, `examples/hono/README.md`).
  - Validate end-to-end from loader to runner (`examples/hono/loader/src/index.ts`, `examples/hono/runner/src/index.ts`).

- [ ] Fix `run()` ESM semantics to match docs (return module exports/default instead of evaluation result).
  - `packages/sandboxed-node/src/index.ts`

- [ ] Fix dynamic import execution semantics so imports are not eagerly evaluated before user code.
  - `packages/sandboxed-node/src/index.ts`

- [x] Remove brittle require-path hacks/monkeypatches and replace with minimal, explicit compatibility behavior.
  - Current hacks include `chalk`, `supports-color`, `tty`, `constants`, `v8`, and `util/url/path` patching.
  - `packages/sandboxed-node/src/shared/require-setup.ts`

- [ ] Decide and enforce sandbox permission default model (allow-by-default vs deny-by-default); tighten if strict mode is desired.
  - `packages/sandboxed-node/src/shared/permissions.ts`

- [ ] Make console capture robust for circular objects (avoid `JSON.stringify` throw paths in logging).
  - `packages/sandboxed-node/src/index.ts`

- [ ] Reconcile `docs-internal/node/STDLIB_COMPATIBILITY.md` with current runtime behavior.
  - Remove stale third-party bridge notes (for example `@hono/node-server`) and keep module status accurate after bridge changes.
  - Ensure `http`/`https`/`http2` sections reflect built-in-only bridge policy and current support limits.

- [ ] Close or explicitly codify missing `fs` APIs listed in compatibility docs.
  - Missing list currently includes: `watch`, `watchFile`, `access`, `chmod`, `chown`, `link`, `symlink`, `readlink`, `truncate`, `utimes`, `realpath`.
  - Decide per API: implement bridge support vs explicit unsupported error contract.

- [ ] Decide `child_process.fork()` support level.
  - Either implement a constrained fork/IPC model for sandboxed-node or mark `fork` as explicitly unsupported with deterministic runtime errors/tests.

- [ ] Tighten crypto support policy and implementation.
  - Replace non-cryptographic random stubs where security-sensitive APIs are exposed, or explicitly disable them with clear errors.
  - Document exact supported crypto surface in compatibility docs and tests.

- [ ] Track unimplemented core modules from compatibility docs as explicit product decisions.
  - Current list includes: `net`, `tls`, `dgram`, `http2` (full), `cluster`, `worker_threads`, `wasi`, `perf_hooks`, `async_hooks`, `diagnostics_channel`, `inspector`, `repl`, `readline`, `trace_events`, `domain`.
  - For each module, decide: implement now, defer, or permanently unsupported; enforce consistent runtime behavior and docs.
