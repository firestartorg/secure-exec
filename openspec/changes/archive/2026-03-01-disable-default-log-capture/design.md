## Context

secure-exec currently captures console output into in-memory `stdout`/`stderr` buffers for each execution. This behavior is convenient for tests and small payloads but it creates a host-memory amplification vector: untrusted code can emit arbitrarily large log volume and force host-side accumulation. The requested direction is security-first logging behavior for the runtime: no buffered capture by default, optional streaming-only emission hook for hosts that want logs.

This change is cross-cutting across runtime execution flow, API shape, and compatibility expectations because many tests and fixtures currently assert captured stdout/stderr text.

## Goals / Non-Goals

**Goals:**
- Make runtime logging non-buffering by default so console output does not accumulate in host memory.
- Default behavior: drop sandbox console output unless host explicitly configures a streaming hook.
- Provide an explicit runtime hook that emits ordered log events (`stdout`/`stderr` channel semantics) as a stream.
- Preserve runtime stability for complex log values (including circular structures) without throwing.
- Update governance/docs to capture compatibility and security rationale.

**Non-Goals:**
- Preserving current buffered `stdout`/`stderr` capture semantics.
- Building persistent log storage, batching, or replay queues in secure-exec.
- Introducing bridge-level log transport that bypasses runtime hook configuration.

## Decisions

### Decision: Default to log drop, not log capture
- Runtime execution paths no longer accumulate console output into per-run buffers by default.
- When no hook is configured, logs are ignored.

Rationale:
- Eliminates the default host-memory growth vector from untrusted log volume.
- Aligns with a security-first default posture for hostile workloads.

Alternatives considered:
- Keep capture with tighter limits: rejected because any non-trivial default buffer still creates memory pressure risk and policy complexity.
- Make capture opt-in but still buffered: rejected because buffering remains the core hazard.

### Decision: Expose one optional streaming log hook
- Add a host callback option on runtime construction/execution for log events.
- Hook receives each log emission in execution order with channel metadata; secure-exec does not retain history.

Rationale:
- Gives hosts observability without forcing runtime-owned buffering.
- Keeps logging responsibility in host `driver`/application layer where backpressure and storage policy can be managed.

Alternatives considered:
- Multiple hook types (per-level/per-module): deferred; adds API complexity without changing safety posture.

### Decision: Keep serialization safety and bounded work in streaming path
- Existing bounded serialization protections remain in effect before hook emission.
- Circular references are still rendered safely (for example `[Circular]`) rather than throwing.

Rationale:
- Prevents log argument shape from crashing execution.
- Preserves deterministic, bounded work guarantees independent of capture mode.

Alternatives considered:
- Raw object passthrough to hook: rejected; exposes isolate object-transfer complexity and unbounded host work.

## Risks / Trade-offs

- [Risk] Existing tests/tools depend on buffered `stdout`/`stderr` fields → Mitigation: migrate tests to hook-based assertions and document breaking behavior explicitly.
- [Risk] Hosts may assume logs are still available post-execution → Mitigation: require explicit hook configuration and update runtime/security docs with default log-drop contract.
- [Risk] Hook implementations can still exhaust host resources if they buffer unsafely → Mitigation: document that hook consumers own storage/backpressure policy.

## Migration Plan

1. Add runtime API support for optional log streaming hook and remove default capture accumulation paths.
2. Refactor console setup to emit serialized events directly to hook (if configured) and otherwise discard.
3. Update tests from captured output assertions to hook-event assertions where logging behavior is under test.
4. Update compatibility/friction/security documentation for the breaking logging contract.

Rollback:
- Reintroduce buffered capture only behind explicit compatibility mode if migration blockers appear; do not restore as default.

## Open Questions

- Should the hook be configured only at `NodeProcess` construction, or also per `exec`/`run` call overrides?
- Should hook delivery failures be swallowed (best-effort) or fail execution deterministically?
