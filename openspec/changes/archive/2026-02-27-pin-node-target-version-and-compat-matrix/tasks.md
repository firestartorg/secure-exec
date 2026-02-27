## 1. OpenSpec Governance Updates

- [x] 1.1 Update `openspec/specs/compatibility-governance/spec.md` to define `docs/node-compatability.mdx` as the canonical compatibility matrix path.
- [x] 1.2 Add governance language that binds the target Node compatibility baseline to the `@types/node` major version used in validation workflows.
- [x] 1.3 Ensure governance requirements explicitly forbid active references to the legacy internal stdlib compatibility document.

## 2. Documentation-Site Spec Updates

- [x] 2.1 Update `openspec/specs/documentation-site/spec.md` so navigation requirements include `node-compatability` alongside existing required docs pages.
- [x] 2.2 Add a requirement that `docs/node-compatability.mdx` shows the target Node version at the top and includes a concise compatibility table.

## 3. Node Compatibility Documentation Migration

- [x] 3.1 Create `docs/node-compatability.mdx` with a top-of-page target version statement aligned with current `@types/node` baseline.
- [x] 3.2 Migrate compatibility content from the legacy internal stdlib compatibility document into a cleaned, simple table format in `docs/node-compatability.mdx`.
- [x] 3.3 Fix spelling and wording issues in the migrated content while preserving support-tier semantics.
- [x] 3.4 Update `docs/docs.json` navigation so the Node Compatibility page is discoverable.
- [x] 3.5 Clarify in `docs/node-compatability.mdx` that permission-model guidance is scoped to runtime/bridge semantics and excludes driver convenience defaults from canonical security behavior.

## 4. Reference Cleanup and Verification

- [x] 4.1 Remove the legacy internal stdlib compatibility document after migration is complete.
- [x] 4.2 Replace remaining repository references to the legacy internal stdlib compatibility document with `docs/node-compatability.mdx`.
- [x] 4.3 Verify with `rg` that the legacy internal stdlib compatibility filename and path are absent from the repository.
