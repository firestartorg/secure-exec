## 1. Runtime API And Execution Contract Updates

- [x] 1.1 Add runtime API surface for optional log streaming hook (construction and/or per-exec configuration) in `packages/secure-exec/src/shared/api-types.ts` and `packages/secure-exec/src/index.ts`.
- [x] 1.2 Remove default `stdout`/`stderr` accumulation paths from runtime execution flow while preserving existing non-log failure contracts.
- [x] 1.3 Ensure no-hook mode deterministically drops console emissions and keeps runtime-managed capture buffers empty.

## 2. Console Pipeline Refactor

- [x] 2.1 Refactor console formatter/setup so log serialization emits directly to hook callbacks (when configured) instead of buffered append behavior.
- [x] 2.2 Preserve circular-safe and bounded serialization behavior in streaming mode, including deterministic truncation markers.
- [x] 2.3 Define deterministic hook ordering semantics across `console.log`/`warn`/`error` channels and document hook failure behavior.

## 3. Test Coverage (Including Exploit Paths)

- [x] 3.1 Update existing runtime logging tests in `packages/secure-exec/tests/index.test.ts` from buffered-output assertions to explicit log-hook assertions.
- [x] 3.2 Add a regression test for default log-drop mode verifying `console.log`/`console.error` do not populate runtime-managed `stdout`/`stderr` fields.
- [x] 3.3 Add a regression test for streaming-hook event ordering across interleaved stdout/stderr channel emissions.
- [x] 3.4 Add exploit-path stress coverage that emits very high log volume and asserts runtime does not accumulate buffered host-memory output by default.
- [x] 3.5 Add regression tests for circular and deeply nested log arguments in hook mode to verify bounded serialization and non-throw behavior.

## 4. Documentation And Validation

- [x] 4.1 Update `docs-internal/friction/secure-exec.md` with the security rationale and compatibility trade-off for default log-drop behavior.
- [x] 4.2 Update `docs/security-model.mdx` and `docs/node-compatability.mdx` with the new logging contract (default ignore + explicit streaming hook).
- [x] 4.3 Run required checks and record results in this task file: `pnpm -C packages/secure-exec check-types`, targeted `vitest` suites for logging behavior, and `pnpm turbo build --filter secure-exec`.
  - `pnpm -C packages/secure-exec check-types` ✅
  - `pnpm --dir packages/secure-exec exec vitest run tests/index.test.ts tests/console-formatter.test.ts tests/module-access.test.ts tests/payload-limits.test.ts` ✅
  - `pnpm --dir packages/secure-exec exec vitest run tests/module-access-compat.test.ts` ✅
  - `pnpm --dir packages/secure-exec exec vitest run tests/project-matrix.test.ts -t "runs fixture dotenv-pass in host node and secure-exec"` ✅
  - `pnpm turbo build --filter secure-exec` ✅
