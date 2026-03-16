# runtime-driver-test-suite-structure Specification

## Purpose
TBD - created by archiving change restructure-test-suite-layout. Update Purpose after archive.
## Requirements
### Requirement: Runtime Test Suite SHALL Use A Canonical Flat Layout
Secure-exec runtime-driver integration coverage MUST use the canonical filesystem layout:

- `packages/secure-exec/tests/test-suite.test.ts`
- `packages/secure-exec/tests/test-suite/{name}.ts`
- `packages/secure-exec/tests/exec-driver/{name}.test.ts`
- `packages/secure-exec/tests/runtime-driver/{name}.test.ts`

#### Scenario: Shared matrix entrypoint exists at canonical path
- **WHEN** contributors add or update shared runtime-driver suite orchestration
- **THEN** orchestration MUST live in `packages/secure-exec/tests/test-suite.test.ts`

#### Scenario: Shared suites are flat under test-suite folder
- **WHEN** contributors add or update shared matrix-applied runtime suites
- **THEN** each shared suite MUST live directly under `packages/secure-exec/tests/test-suite/` as `*.ts`

#### Scenario: Driver-specific suites are separated by driver responsibility
- **WHEN** assertions cannot be shared across all compatible driver pairs
- **THEN** execution-driver-specific assertions MUST live under `packages/secure-exec/tests/exec-driver/*.test.ts` and runtime-driver-specific assertions MUST live under `packages/secure-exec/tests/runtime-driver/*.test.ts`

### Requirement: Shared Runtime Suites SHALL Execute Across Compatible Driver Pairs Without Exclusions
The shared runtime test suite MUST define a compatibility matrix of `(execution driver, runtime driver)` pairs and MUST execute the same shared suite registration for every compatible pair.

#### Scenario: Compatible pair runs full shared suite set
- **WHEN** a pair is marked compatible in `test-suite.test.ts`
- **THEN** all shared suites registered from `packages/secure-exec/tests/test-suite/*.ts` MUST execute for that pair

#### Scenario: Incompatible pair is excluded deterministically
- **WHEN** a pair is not supported by runtime contracts
- **THEN** the pair MUST be omitted only through explicit compatibility-matrix rules in `test-suite.test.ts`

#### Scenario: Pair-specific suite filtering is disallowed
- **WHEN** shared suites run for a compatible pair
- **THEN** the test harness MUST NOT skip or filter shared suites based on specific driver names

### Requirement: Shared Suite Registration SHALL Be Deterministic
Shared suite registration order in the matrix entrypoint MUST be explicit and stable.

#### Scenario: Shared suites are imported explicitly
- **WHEN** shared suites are registered from `test-suite.test.ts`
- **THEN** they MUST be imported and invoked in deterministic source order rather than filesystem discovery

