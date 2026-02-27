## Why

The runtime currently exposes high-resolution wall-clock behavior (`Date.now`, `performance.now`, `process.hrtime`) and has no execution budget, which makes timing side-channel probing and denial-of-service loops easier than they should be for untrusted code execution. We need a first-class mitigation path that reduces timing signal quality without silently breaking default Node-compatible behavior.

## What Changes

- Add an opt-in runtime hardening profile that freezes or coarsens time sources visible to sandboxed code during a single execution window.
- Add an execution budget (`executionTimeoutMs`) that terminates long-running user code paths instead of allowing unbounded CPU loops.
- Route bridge-level timer APIs and process timing helpers through the same hardened clock source when hardening is enabled.
- Ensure `SharedArrayBuffer` is unavailable in the hardened profile to remove high-precision shared-memory timing primitives.
- Add regression tests that verify both modes:
  - default mode remains Node-like for timing behavior;
  - hardened mode returns deterministic/coarsened timing values and enforces execution timeout.
- Update internal compatibility/friction documentation to record the intentional Node deviation when hardening mode is enabled.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `node-runtime`: add execution-time hardening controls (clock policy + timeout budget) and define required runtime behavior for hardened vs default modes.
- `compatibility-governance`: require explicit compatibility/friction documentation updates when security hardening intentionally diverges from Node timing semantics.

## Impact

- Affected code: `packages/sandboxed-node/src/index.ts`, `packages/sandboxed-node/src/shared/api-types.ts`, and bridge timing paths under `packages/sandboxed-node/src/bridge/`.
- Affected tests: `packages/sandboxed-node/tests/index.test.ts` and/or targeted compatibility fixtures for timing behavior.
- Affected docs: `docs-internal/research/comparison/cloudflare-workers-isolates.md` and `docs-internal/friction/sandboxed-node.md`.
