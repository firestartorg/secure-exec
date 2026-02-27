## ADDED Requirements

### Requirement: Configurable Execution Timeout Budget
The Node runtime MUST support a configurable execution timeout budget for sandboxed code evaluation, and MUST enforce that budget across runtime entrypoints that execute user code.

#### Scenario: Infinite loop is terminated by timeout budget
- **WHEN** a caller configures `executionTimeoutMs` and executes code containing a non-terminating loop
- **THEN** execution MUST be interrupted with a timeout-related runtime error and return a non-zero exit code

#### Scenario: Timeout-disabled execution preserves existing behavior
- **WHEN** a caller does not configure `executionTimeoutMs`
- **THEN** the runtime MUST preserve current no-timeout behavior for execution duration control

### Requirement: Optional Timing Side-Channel Mitigation Profile
The Node runtime MUST provide an opt-in timing mitigation mode that reduces high-resolution timing signals exposed to sandboxed code while preserving Node-like timing behavior by default.

#### Scenario: Default timing mode remains Node-like
- **WHEN** a caller executes code with `timingMitigation` unset or set to `"off"`
- **THEN** `Date.now()` and `performance.now()` MUST advance with real execution time semantics

#### Scenario: Hardened timing mode freezes execution clocks
- **WHEN** a caller executes code with `timingMitigation` set to `"freeze"`
- **THEN** repeated reads of `Date.now()`, `performance.now()`, and `process.hrtime()` within the same execution MUST return deterministic frozen-time values

#### Scenario: Hardened timing mode removes shared-memory timing primitive
- **WHEN** a caller executes code with `timingMitigation` set to `"freeze"`
- **THEN** `SharedArrayBuffer` MUST NOT be available on `globalThis`
