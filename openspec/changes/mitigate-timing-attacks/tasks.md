## 1. Runtime Security Options

- [ ] 1.1 Extend `NodeProcessOptions` and shared API types with `executionTimeoutMs` and `timingMitigation` (`"off" | "freeze"`) defaults.
- [ ] 1.2 Plumb `executionTimeoutMs` through user-code execution boundaries (`script.run`, `module.evaluate`, awaited eval paths) in `NodeProcess.executeInternal`.
- [ ] 1.3 Normalize timeout failures into deterministic runtime error handling and non-zero exit behavior for `run()` and `exec()`.

## 2. Timing Mitigation Wiring

- [ ] 2.1 Add an execution-scoped hardened clock installer in `NodeProcess` that activates only when `timingMitigation === "freeze"`.
- [ ] 2.2 Route process timing helpers (`process.hrtime`, `process.hrtime.bigint`, `process.uptime`) through hardened clock state when active.
- [ ] 2.3 Remove `SharedArrayBuffer` from sandbox globals in freeze mode and verify default mode behavior is unchanged.

## 3. Verification And Documentation

- [ ] 3.1 Add targeted vitest coverage for default vs freeze timing behavior (`Date.now`, `performance.now`, `process.hrtime`, `SharedArrayBuffer` visibility).
- [ ] 3.2 Add targeted vitest coverage for timeout budget enforcement (`executionTimeoutMs`) including infinite-loop termination.
- [ ] 3.3 Update `docs-internal/research/comparison/cloudflare-workers-isolates.md` and `docs-internal/friction/sandboxed-node.md` with the approved mitigation and compatibility notes.
- [ ] 3.4 Run targeted checks: `pnpm --filter sandboxed-node test -- tests/index.test.ts` and `pnpm --filter sandboxed-node check-types`.
