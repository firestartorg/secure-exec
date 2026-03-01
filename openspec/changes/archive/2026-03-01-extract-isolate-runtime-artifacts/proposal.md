## Why

Code executed inside the isolate is currently assembled from multiple runtime helpers using generated string snippets (for example `getRequireSetupCode` and bridge-loader wrappers). That makes isolate bootstrap behavior harder to audit, test, and build deterministically, and it increases risk of accidental behavior drift from Node-compatible runtime semantics.

## What Changes

- Move isolate-executed bootstrap/injection sources into a dedicated `packages/secure-exec/isolate-runtime/` source tree.
- Treat isolate-injected code as static TypeScript source files, compiled as build artifacts, instead of assembling executable source with runtime template literals.
- Update `packages/secure-exec/package.json` to add an explicit isolate-runtime compile step and make the main package build depend on it.
- Update `turbo.json` so isolate-runtime compilation is part of the package build dependency graph.
- Refactor runtime injection paths (`NodeProcess`, browser worker bootstrap, and bridge loader wrappers) to load compiled isolate-runtime artifacts and pass runtime data without template-literal source synthesis.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `node-runtime`: add explicit runtime assembly requirements for static isolate bootstrap sources, build ordering, and template-literal-free code injection.

## Impact

- Affected code:
  - `packages/secure-exec/src/index.ts`
  - `packages/secure-exec/src/browser/worker.ts`
  - `packages/secure-exec/src/bridge-loader.ts`
  - `packages/secure-exec/src/shared/require-setup.ts` (or successor under isolate-runtime)
  - new files under `packages/secure-exec/isolate-runtime/`
  - `packages/secure-exec/package.json`
  - `turbo.json`
- Affected tests: secure-exec runtime/bootstrap coverage and any tests that assert bridge/require setup behavior.
- Build/dependency impact: secure-exec build graph gains isolate-runtime compilation as a required dependency.
