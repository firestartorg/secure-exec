## Why

`sandboxed-node` still relies on brittle monkeypatches and ad hoc module stubs in `require-setup`, which increases maintenance risk and conflicts with the strict bridge boundary policy. This change formalizes cleanup of those hacks as a dedicated follow-up.

## What Changes

- Remove or minimize brittle require-time hacks for `chalk`, `supports-color`, `tty`, `constants`, `v8`, and util/url/path patching.
- Replace ad hoc compatibility behavior with explicit, minimal, policy-compliant mechanisms.
- Update compatibility documentation to reflect resulting supported/unsupported behavior.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `node-bridge`: enforce stricter compliance around bridge/module boundaries and compatibility behavior.
- `compatibility-governance`: require synchronized compatibility documentation for any resulting API-surface behavior changes.

## Impact

- Affected code: `packages/sandboxed-node/src/shared/require-setup.ts` and related module-loading paths.
- Affected docs: `docs/node-compatability.mdx`.
- Affected follow-up validation: bridge/runtime compatibility tests.
