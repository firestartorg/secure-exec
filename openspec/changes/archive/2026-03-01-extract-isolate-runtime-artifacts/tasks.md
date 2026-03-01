## 1. Isolate-Runtime Source Extraction

- [ ] 1.1 Inventory every host-to-isolate injection path in `packages/secure-exec/src/` (including `index.ts`, `browser/worker.ts`, `bridge-loader.ts`, and require setup helpers) and map each to a file in `packages/secure-exec/isolate-runtime/`.
- [ ] 1.2 Move `getRequireSetupCode`-style injected source and bridge/bootstrap injected source into static `.ts` modules under `packages/secure-exec/isolate-runtime/`.
- [ ] 1.3 Update runtime injection call sites to load isolate bootstrap code from the new isolate-runtime modules/artifacts only.

## 2. Build and Task-Graph Wiring

- [ ] 2.1 Add `build:isolate-runtime` to `packages/secure-exec/package.json` and make `build` depend on it before final TypeScript/package build steps.
- [ ] 2.2 Update `turbo.json` so secure-exec `build` depends on `build:isolate-runtime` and caches its outputs.
- [ ] 2.3 Ensure isolate-runtime outputs are emitted under `dist/isolate-runtime/**` and consumed by runtime loaders in both Node and browser runtime paths.

## 3. Remove Template-Literal Code Generation

- [ ] 3.1 Refactor isolate-injected source assembly so executable injected code is not produced via template-literal code generation.
- [ ] 3.2 Replace per-execution string interpolation with structured data channels consumed by static isolate-runtime source (for example globals/config payloads).
- [ ] 3.3 Add regression checks that fail if new template-literal-based executable isolate injection is introduced.

## 4. Compatibility and Verification

- [ ] 4.1 Add or update runtime tests to confirm require/bridge/bootstrap behavior remains parity-consistent after isolate-runtime extraction.
- [ ] 4.2 Run secure-exec verification commands: `pnpm -C packages/secure-exec check-types`, `pnpm -C packages/secure-exec test`, and `pnpm turbo build --filter secure-exec`.
- [ ] 4.3 Update `docs-internal/friction/secure-exec.md` with migration notes and mark resolved friction related to dynamic isolate code assembly.
