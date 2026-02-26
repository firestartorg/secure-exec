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

- [ ] Remove brittle require-path hacks/monkeypatches and replace with minimal, explicit compatibility behavior.
  - Current hacks include `chalk`, `supports-color`, `tty`, `constants`, `v8`, and `util/url/path` patching.
  - `packages/sandboxed-node/src/shared/require-setup.ts`

- [ ] Decide and enforce sandbox permission default model (allow-by-default vs deny-by-default); tighten if strict mode is desired.
  - `packages/sandboxed-node/src/shared/permissions.ts`

- [ ] Make console capture robust for circular objects (avoid `JSON.stringify` throw paths in logging).
  - `packages/sandboxed-node/src/index.ts`
