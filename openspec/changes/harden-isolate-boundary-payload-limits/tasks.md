## 1. Add shared boundary size guards

- [ ] 1.1 Define runtime constants/helpers for maximum isolate-boundary base64 transfer size and maximum isolate-originated JSON payload size in `packages/sandboxed-node/src/index.ts`.
- [ ] 1.2 Implement deterministic overflow error construction so guard failures return stable bridge/runtime errors instead of process-fatal behavior.

## 2. Guard base64 file-transfer paths

- [ ] 2.1 Add outbound size validation in `readFileBinaryRef` before returning large base64 payloads across the isolate boundary.
- [ ] 2.2 Add inbound size validation in `writeFileBinaryRef` before base64 decode/allocation.
- [ ] 2.3 Add targeted tests for oversized/within-limit binary read and write payloads.

## 3. Guard host-side JSON parsing

- [ ] 3.1 Enumerate all isolate-originated `JSON.parse` callsites in `packages/sandboxed-node/src/index.ts` and route them through a shared pre-parse size-check helper.
- [ ] 3.2 Add targeted regression tests that verify oversized JSON payloads fail deterministically and in-limit payloads preserve current behavior.

## 4. Sync docs and verify

- [ ] 4.1 Update `docs-internal/friction/sandboxed-node.md` with the boundary-size guardrail behavior and fix notes.
- [ ] 4.2 Update `docs/security-model.mdx` to document isolate-boundary payload limits, deterministic overflow behavior, and compatibility trade-offs.
- [ ] 4.3 Run focused validation: `pnpm --filter sandboxed-node test -- --run <targeted-tests>` and `pnpm --filter sandboxed-node check-types`.
