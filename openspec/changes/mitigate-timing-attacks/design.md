## Context

`sandboxed-node` currently prioritizes Node-like behavior and exposes real-time clocks (`Date.now()`, `performance.now()`, `process.hrtime()`), while runtime execution has no bounded CPU budget. The comparison research identifies this as a practical timing side-channel gap and a denial-of-service risk (`while(true){}` style loops).

The project constraint is to remain as close to Node semantics as practical, so timing hardening cannot silently change default behavior. We need an explicit, opt-in hardening path for untrusted workloads, with documentation that records intentional compatibility deviations.

## Goals / Non-Goals

**Goals:**
- Add an opt-in timing-hardening mode for untrusted execution.
- Add an execution timeout budget enforced by isolated-vm run options.
- Keep default runtime behavior Node-compatible unless hardening is explicitly enabled.
- Define testable behavior for both default and hardened modes.

**Non-Goals:**
- Full Spectre-class mitigation parity with Cloudflare’s production stack (perf counters, dynamic process isolation, memory reshuffling).
- OS-level sandboxing (seccomp/namespaces) in this change.
- Reworking the full bridge permission model.

## Decisions

### 1. Add explicit execution security options on `NodeProcessOptions`

Decision:
- Introduce an opt-in configuration surface:
  - `executionTimeoutMs?: number`
  - `timingMitigation?: "off" | "freeze"`

Rationale:
- `executionTimeoutMs` maps directly to isolated-vm `timeout` run options.
- `timingMitigation` keeps default behavior unchanged (`"off"`), while allowing secure deployments to opt into low-resolution timing.

Alternatives considered:
- Always-on frozen clocks: rejected because it is a broad Node compatibility break.
- Single boolean `secureMode`: rejected because future hardening controls need independent tuning.

### 2. Apply timeout consistently to user-code execution boundaries

Decision:
- Pass `timeout` to isolate execution calls that execute user code (`script.run`, `module.evaluate`, and Promise-await eval paths).
- Treat timeout failures as execution errors with deterministic stderr text and non-zero exit code.

Rationale:
- This directly mitigates infinite-loop/CPU lock attacks in the highest-risk path without requiring process-level kill orchestration.

Alternatives considered:
- Host-side watchdog that disposes the isolate: rejected for this change because `NodeProcess` reuse semantics would need larger lifecycle refactors.

### 3. Freeze isolate-observable clocks only when mitigation is enabled

Decision:
- Capture a per-execution timestamp and install hardened globals in the isolate before user code runs:
  - Freeze `Date.now()` and zero/constant `performance.now()` in that execution.
  - Ensure process timing helpers (`process.hrtime`, `process.uptime`) derive from the hardened clock path.
  - Remove `SharedArrayBuffer` from `globalThis` in hardened mode.

Rationale:
- Freezing clocks reduces timing signal quality while preserving deterministic behavior for scripts that still read time.
- `SharedArrayBuffer` removal avoids high-precision shared-memory timing primitives.

Alternatives considered:
- Coarsened (bucketed) clocks instead of full freeze: deferred; can be added as a future mitigation mode if needed.

### 4. Record Node-compatibility deviation as governance output

Decision:
- Require updates to compatibility/friction docs whenever timing hardening behavior intentionally diverges from Node semantics.

Rationale:
- This satisfies project policy that intentional deviations must be explicit and discoverable.

## Risks / Trade-offs

- Hardening mode can break apps relying on monotonic time deltas or real wall-clock progression.
  - Mitigation: default mode remains unchanged; hardening is opt-in and documented.
- Timeout can terminate legitimate long-running workloads.
  - Mitigation: make timeout configurable and disabled unless explicitly set.
- Partial timeout coverage could miss edge paths if new execution entry points are added later.
  - Mitigation: add focused tests and require timeout option plumbing checks when runtime execution code changes.
