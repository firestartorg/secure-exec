## 1. Expand Virtual Filesystem Metadata Contracts

- [ ] 1.1 Add `stat` and typed directory entry support to `VirtualFileSystem` in `packages/sandboxed-node/src/types.ts` and update exported types as needed.
- [ ] 1.2 Update filesystem wrappers/stubs in `packages/sandboxed-node/src/shared/permissions.ts` to enforce permissions for new metadata and rename operations.
- [ ] 1.3 Implement new metadata/rename methods in built-in drivers (`node/driver.ts`, `browser/driver.ts`, `shared/in-memory-fs.ts`) with Node-compatible behavior contracts.

## 2. Remove O(file size) and N+1 Helper Paths

- [ ] 2.1 Refactor `packages/sandboxed-node/src/fs-helpers.ts` so `stat` and `exists` delegate to metadata APIs instead of reading file contents.
- [ ] 2.2 Replace `readDirWithTypes` per-entry probing with typed directory entry retrieval (or `stat`-based metadata fallback only where required).
- [ ] 2.3 Replace helper-level copy-write-delete rename with driver-native rename semantics and deterministic unsupported-path behavior.
- [ ] 2.4 Update runtime consumers (`index.ts`, `browser/worker.ts`, `package-bundler.ts`) to use the new metadata APIs.

## 3. Bridge FS Constant and Semantics Cleanup

- [ ] 3.1 Replace magic open-flag integers in `packages/sandboxed-node/src/bridge/fs.ts` with named constants and constant composition matching Node `fs.constants` semantics.
- [ ] 3.2 Ensure bridge `stat`, `exists`, and typed `readdir` paths preserve metadata-only behavior and do not trigger file-content reads.
- [ ] 3.3 Run bridge type conformance checks (`pnpm run check-types:test` in `packages/sandboxed-node`) after bridge updates.

## 4. Split Monolithic Runtime Assembly

- [ ] 4.1 Extract isolate lifecycle and timeout/timing helpers into `packages/sandboxed-node/src/isolate.ts`.
- [ ] 4.2 Extract module resolution logic into `packages/sandboxed-node/src/module-resolver.ts`.
- [ ] 4.3 Extract ESM compilation/wrapping logic into `packages/sandboxed-node/src/esm-compiler.ts`.
- [ ] 4.4 Extract bridge reference wiring into `packages/sandboxed-node/src/bridge-setup.ts`.
- [ ] 4.5 Extract execution orchestration into `packages/sandboxed-node/src/execution.ts` and reduce `index.ts` to API surface/composition.

## 5. Compatibility, Friction, and Verification

- [ ] 5.1 Add or update black-box compatibility project fixtures under `packages/sandboxed-node/tests/projects/` for `stat`, `exists`, typed `readdir`, and rename semantics parity.
- [ ] 5.2 Update `docs-internal/friction/sandboxed-node.md` with resolved notes and any intentional Node deviation (for example non-atomic rename limits on specific drivers).
- [ ] 5.3 Update compatibility documentation (including matrix references) for metadata/rename behavior changes.
- [ ] 5.4 Run targeted verification: `pnpm vitest` for affected sandboxed-node tests, `pnpm tsc --noEmit` (or package typecheck script), and `pnpm turbo build --filter sandboxed-node`.
