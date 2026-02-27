## Why

The project needs one explicit Node.js compatibility target so runtime behavior, tests, and docs all reference the same baseline. The current compatibility matrix lives in an internal markdown file and is difficult to consume or keep aligned with external docs.

## What Changes

- Define and document Node.js `22.x` as the current targeted compatibility baseline in OpenSpec governance language (derived from the `@types/node` major used by validation).
- Require compatibility validation to be tied to the `@types/node` package version used in sandboxed-node test validation.
- Add a docs page at `docs/node-compatability.mdx` with a clean compatibility matrix table and the target Node version shown at the top.
- Scope permission-model documentation to the core runtime/bridge contract, excluding Node driver convenience-default behavior from canonical compatibility/security semantics.
- Migrate content from the legacy internal stdlib compatibility document into the new docs page with cleaned wording/table formatting.
- Remove all repository references to the legacy internal stdlib compatibility document and replace them with the new canonical documentation path.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `compatibility-governance`: Add requirements that define the canonical target Node version contract and require alignment with `@types/node` used by tests.
- `documentation-site`: Add requirements for a Node compatibility documentation page and required top-of-page target-version callout.

## Impact

- OpenSpec deltas under `openspec/changes/pin-node-target-version-and-compat-matrix/specs/` for governance and docs capabilities.
- Documentation updates in `docs/` and docs navigation config.
- Removal/replacement of references that currently point to the legacy internal stdlib compatibility document.
- Follow-up implementation should keep compatibility/friction docs consistent with any intentional Node behavior deviations.
