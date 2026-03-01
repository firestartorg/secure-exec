## Why

The current runtime buffers all console output in host memory (`stdout`/`stderr` capture), which creates an unbounded resource-exhaustion risk for long-running or hostile workloads. We need a security-first logging contract that does not retain logs by default and only emits logs through explicit host streaming hooks.

## What Changes

- **BREAKING** Remove default in-memory capture of sandbox console output for `exec`/`run` paths.
- **BREAKING** Default runtime behavior becomes log-drop: when no hook is configured, sandbox console output is ignored.
- Add an explicit host hook for streaming log events out of the `runtime` as they occur, without buffered accumulation inside secure-exec.
- Remove/replace runtime capture-oriented behavior that depends on buffered `stdout`/`stderr` contracts (including capture-size/serialization assumptions) with streaming-oriented behavior.
- Update compatibility and friction documentation to record this intentional deviation from Node-like process stdio capture expectations and the security rationale.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `node-runtime`: replace buffered console-capture requirements with default log-drop + explicit streaming-hook requirements.
- `compatibility-governance`: require documentation updates for this security-motivated logging contract change and its compatibility trade-offs.

## Impact

- Affected code:
  - `packages/secure-exec/src/index.ts`
  - `packages/secure-exec/src/shared/console-formatter.ts`
  - `packages/secure-exec/src/shared/api-types.ts`
  - runtime/bootstrap surfaces that currently wire `stdout`/`stderr` capture
- Affected tests:
  - `packages/secure-exec/tests/index.test.ts` (console/logging expectations)
  - new tests for default log-drop and streaming-hook emission semantics
  - any fixture/tests depending on buffered stdout/stderr from secure-exec runtime
- Affected docs/governance:
  - `docs-internal/friction/secure-exec.md`
  - `docs/security-model.mdx`
  - `docs/node-compatability.mdx` (if user-facing compatibility matrix/logging behavior callouts are impacted)
