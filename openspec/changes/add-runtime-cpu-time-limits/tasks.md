## 1. API and Runtime Budget Plumbing

- [ ] 1.1 Add `cpuTimeLimitMs` to `NodeProcessOptions` and `ExecOptions` types.
- [ ] 1.2 Implement runtime budget/deadline helper(s) that derive remaining timeout for each isolate call.
- [ ] 1.3 Define precedence rules between constructor-level and per-call `cpuTimeLimitMs`.

## 2. Timeout Enforcement

- [ ] 2.1 Apply timeout options to CommonJS execution paths (`script.run` and related eval paths).
- [ ] 2.2 Apply timeout options to ESM module evaluation and dynamic import evaluation paths.
- [ ] 2.3 Apply timeout-aware waiting to active-handle completion paths.
- [ ] 2.4 Normalize timeout failures to deterministic contract (`code: 124`, `CPU time limit exceeded`).
- [ ] 2.5 Recycle isolate state after timeout before subsequent executions.

## 3. Verification and Documentation

- [ ] 3.1 Add tests for CJS infinite loop timeout behavior.
- [ ] 3.2 Add tests for ESM and dynamic import timeout behavior.
- [ ] 3.3 Add test coverage for shared deadline behavior across multi-phase execution (including active-handle wait).
- [ ] 3.4 Update `docs-internal/research/comparison/cloudflare-workers-isolates.md` to match implemented timeout contract.
- [ ] 3.5 Update `docs-internal/friction/sandboxed-node.md` with CPU timeout deviation/fix notes.
