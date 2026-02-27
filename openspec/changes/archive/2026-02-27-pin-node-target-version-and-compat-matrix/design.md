## Context

The project currently tracks Node standard-library compatibility in a legacy internal markdown file, while public docs in `docs/` do not expose a canonical compatibility matrix page. OpenSpec governance requirements do not define how the target Node version is selected. The runtime and test tooling already rely on `@types/node` in the workspace and `packages/sandboxed-node`, but this relationship is not explicitly captured as the compatibility baseline contract.

## Goals / Non-Goals

**Goals:**
- Define a canonical target Node version contract in OpenSpec that is explicitly tied to the `@types/node` version used by tests.
- Add a public docs page (`docs/node-compatability.mdx`) with a clean matrix table and a top-of-page target-version statement.
- Migrate the compatibility content from the legacy internal stdlib compatibility document into the new docs page.
- Remove all active references to the legacy internal stdlib compatibility document and replace with the canonical docs path.
- Keep compatibility-governance and documentation-site requirements aligned with this documentation structure.

**Non-Goals:**
- Changing runtime bridge behavior, permission behavior, or module support tiers themselves.
- Introducing automated generation for the matrix content in this change.
- Rewriting compatibility fixtures or project-matrix behavior beyond documentation/spec alignment.

## Decisions

### Decision: Target Node baseline is derived from `@types/node`
Use the `@types/node` dependency used for test/type validation as the canonical baseline signal for Node compatibility targeting. The compatibility docs will present the target as a concrete major line (`22.x` at proposal time) and require updates when `@types/node` is intentionally upgraded.

Alternatives considered:
- Pinning an independent `engines.node` value in package metadata: rejected because it can drift from test/type contracts.
- Describing only "latest LTS": rejected because it is ambiguous and time-variant.

### Decision: Canonical compatibility matrix moves to docs site
Move the matrix from internal-only markdown to `docs/node-compatability.mdx` so users and contributors consume one canonical page. The internal file is removed rather than retained as a duplicate source.

Alternatives considered:
- Keeping both files and syncing manually: rejected due to high drift risk.
- Keeping internal only and linking externally: rejected because user-facing compatibility expectations remain obscured.

### Decision: Governance requirements explicitly name canonical docs path and sync obligations
Update `compatibility-governance` requirements to reference the new canonical file and to require that Node target-version statements stay aligned with `@types/node` used in tests.

Alternatives considered:
- Leaving governance path generic: rejected because previous generic language already drifted and produced stale references.

### Decision: Documentation-site spec gains explicit Node compatibility page requirements
Add documentation requirements so navigation, page presence, and top-of-page target-version callout become enforceable contract behavior.

Alternatives considered:
- Treating page creation as a one-off task without spec deltas: rejected because future docs changes would lack normative guardrails.

### Decision: Permission model text is scoped to runtime and bridge contract
The Node compatibility page documents canonical runtime/bridge behavior, not driver-construction convenience defaults. Driver defaults can vary by integration path and should not redefine the core security contract.

Alternatives considered:
- Documenting runtime and driver defaults together as one policy: rejected because it conflates integration convenience behavior with canonical runtime guarantees.

## Risks / Trade-offs

- [Risk] `@types/node` range (`^22.x`) can move over time and make exact version wording stale.
  -> Mitigation: specify target as major-line contract (for example, `22.x`) and require updates whenever dependency upgrades cross major targets.

- [Risk] Removing the internal markdown path may break references in archived artifacts or tooling docs.
  -> Mitigation: update all active references and allow archived records to remain historical snapshots.

- [Risk] Migration to a simplified table can accidentally omit support details currently in the internal document.
  -> Mitigation: include migration task checklist that verifies each module section is represented in the new matrix.

## Migration Plan

1. Add OpenSpec delta requirements for `compatibility-governance` and `documentation-site` describing target-version and canonical page contracts.
2. Create `docs/node-compatability.mdx` with target Node version at the top and a cleaned compatibility table.
3. Port compatibility content from the legacy internal compatibility document into the new page.
4. Update docs navigation to include the new page.
5. Remove the legacy internal compatibility document and replace active repository references.
6. Validate docs/spec consistency and update friction notes only if migration uncovers runtime-contract uncertainty.

## Open Questions

- Should the docs header display only the major target (`22.x`) or include the currently resolved lockfile version (`22.19.3`)?
- Do we want follow-up automation that derives the displayed target directly from `@types/node` to prevent manual drift?
