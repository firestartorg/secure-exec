## Why

Sandboxed-node still diverges from standard Node.js module semantics in several high-friction paths (`import`, `require`, and resolution helpers). These gaps cause behavior differences that are hard to predict and are currently under-tested.

## What Changes

- Align module resolution and loading behavior with Node.js semantics for mixed ESM/CJS execution paths, including builtin resolution helpers and package entrypoint selection.
- Tighten dynamic `import()` behavior so ESM failures surface correctly and fallback behavior does not distort Node-compatible module namespace shapes.
- Improve builtin ESM import compatibility for named exports where Node exposes them.
- Add targeted conformance tests for module-system edge cases (resolver behavior, package metadata semantics, CJS/ESM interop, and dynamic import error paths).
- Document any intentional remaining deviations from Node behavior in compatibility/friction artifacts.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `node-runtime`: strengthen runtime module classification, import/require interop, dynamic import fallback/error behavior, and execution semantics against Node expectations.
- `node-stdlib`: tighten builtin module resolution/import behavior (including resolver helper behavior and builtin ESM surface compatibility).

## Impact

- Affected code: `packages/sandboxed-node/src/index.ts`, `packages/sandboxed-node/src/package-bundler.ts`, `packages/sandboxed-node/src/shared/esm-utils.ts`, `packages/sandboxed-node/src/shared/require-setup.ts`, `packages/sandboxed-node/src/bridge/module.ts`.
- Affected tests: `packages/sandboxed-node/tests/index.test.ts` (new module-compat edge-case scenarios).
- Affected docs: `docs/node-compatability.mdx` and `docs-internal/friction/sandboxed-node.md` for any intentional or remaining deltas.
