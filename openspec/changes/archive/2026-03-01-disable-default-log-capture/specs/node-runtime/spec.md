## MODIFIED Requirements

### Requirement: Circular-Safe Console Output Capture
The runtime SHALL process console arguments without throwing on circular structures, and SHALL avoid retaining console output in execution-result buffers. If a log-stream hook is configured, serialized log events MUST be emitted to the hook without persistent runtime buffering.

#### Scenario: Circular console value with default logging mode
- **WHEN** sandboxed code logs an object containing circular references and no log hook is configured
- **THEN** execution MUST NOT throw due to log serialization and runtime result capture buffers MUST remain empty

#### Scenario: Circular console value with streaming hook configured
- **WHEN** sandboxed code logs an object containing circular references and a log hook is configured
- **THEN** the hook MUST receive a serialized event containing circular-safe markers (for example `[Circular]`) and execution MUST continue

### Requirement: Bounded Console Serialization Work
Console argument serialization SHALL enforce bounded work before log emission, including the streaming-hook path, by applying depth/key/array/output limits with deterministic truncation markers.

#### Scenario: Deep object logging is bounded for streaming hooks
- **WHEN** sandboxed code logs an object exceeding configured depth limits and a log hook is configured
- **THEN** emitted log payloads MUST include deterministic depth truncation markers instead of unbounded traversal

#### Scenario: Large object logging is bounded for streaming hooks
- **WHEN** sandboxed code logs an object/array exceeding configured key or element budgets and a log hook is configured
- **THEN** emitted log payloads MUST include deterministic truncation markers and MUST NOT require unbounded host-runtime serialization work

#### Scenario: Oversized serialized payload is bounded before emission
- **WHEN** serialized console output exceeds configured output-length budgets
- **THEN** emitted log payloads MUST be truncated with deterministic suffix markers and runtime MUST NOT accumulate full unbounded output in memory

### Requirement: Lazy Evaluation of Dynamic Imports
Dynamically imported modules (`import()`) SHALL be evaluated only when the import expression is reached during user code execution, not during the precompilation phase.

#### Scenario: Side effects execute at import call time
- **WHEN** user code logs `before`, awaits `import("./side-effect")`, and then logs `after`, where `./side-effect` logs during evaluation, with a log hook configured
- **THEN** hook events MUST show `before`, module side effects, and `after` in that order

#### Scenario: Conditional dynamic import skips unused branch
- **WHEN** user code contains `if (false) { await import("./unused"); }` where `./unused` logs during evaluation, with a log hook configured
- **THEN** no hook event from `./unused` evaluation MUST be emitted

#### Scenario: Repeated dynamic import returns same module without re-evaluation
- **WHEN** user code calls `await import("./mod")` twice, where `./mod` increments a global counter on evaluation
- **THEN** the counter MUST equal 1 after both imports, and both calls MUST return the same module namespace

### Requirement: Precompilation Without Evaluation
The precompilation phase SHALL resolve and compile dynamic import targets but MUST NOT instantiate or evaluate them before user code reaches the corresponding `import()` expression.

#### Scenario: Precompiled module has no side effects before user code
- **WHEN** a module targeted by a static `import("./target")` specifier logs during evaluation and a log hook is configured
- **THEN** no hook event from that module SHALL be emitted before user code begins executing

#### Scenario: Dynamic import side effects preserve surrounding user-code order
- **WHEN** user code logs `before`, awaits `import("./side-effect")`, and then logs `after`, where `./side-effect` logs during evaluation, with a log hook configured
- **THEN** hook events MUST preserve the order `before`, module side effects, `after`

## ADDED Requirements

### Requirement: Runtime Default Logging Mode Drops Console Output
Runtime logging SHALL be drop-on-floor by default: if no explicit log hook is configured, console emissions MUST NOT be retained in runtime-managed execution-result buffers.

#### Scenario: Exec without log hook does not capture stdout or stderr
- **WHEN** sandboxed code emits `console.log` and `console.error` and runtime executes without a configured log hook
- **THEN** execution MUST complete without buffered log capture and runtime-managed stdout/stderr capture fields MUST remain empty

### Requirement: Runtime Exposes Optional Streaming Log Hook
The Node runtime SHALL expose an optional host hook for streaming console log events (`stdout` and `stderr` channels) in emission order, without retaining runtime-owned history.

#### Scenario: Hook receives ordered events across stdout and stderr channels
- **WHEN** sandboxed code emits interleaved `console.log`, `console.warn`, and `console.error` calls with a configured hook
- **THEN** the hook MUST receive ordered events with channel metadata matching the original emission sequence

#### Scenario: Hook-enabled runtime still avoids buffered accumulation
- **WHEN** high-volume logging is emitted with a configured hook
- **THEN** secure-exec runtime MUST stream events to the hook without accumulating unbounded per-execution log buffers in host memory
