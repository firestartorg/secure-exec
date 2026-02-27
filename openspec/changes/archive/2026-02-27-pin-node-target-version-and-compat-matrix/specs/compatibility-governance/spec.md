## MODIFIED Requirements

### Requirement: Maintain Node Stdlib Compatibility Matrix
Changes affecting bridged or polyfilled Node APIs MUST keep `docs/node-compatability.mdx` synchronized with the actual runtime surface, including supported, limited, and unsupported modules/APIs. Every module entry in the matrix MUST include an explicit support-tier classification (Bridge, Polyfill, Stub, Deferred, or Unsupported) as defined by the `node-stdlib` spec. The page MUST include a top-of-page target Node version statement.

#### Scenario: Bridge API surface changes
- **WHEN** a change adds, removes, or materially alters bridged Node API behavior
- **THEN** the compatibility matrix page at `docs/node-compatability.mdx` MUST be updated in the same change to reflect the new runtime contract

#### Scenario: Legacy internal matrix path appears anywhere in repository docs/spec sources
- **WHEN** a repository document or spec source references the legacy internal stdlib compatibility document
- **THEN** the reference MUST be replaced with `docs/node-compatability.mdx` before the change is considered complete

#### Scenario: Target Node version callout is missing
- **WHEN** `docs/node-compatability.mdx` is updated
- **THEN** the page MUST retain an explicit target Node version statement at the top

## ADDED Requirements

### Requirement: Node Compatibility Target Version Tracks Test Type Baseline
The runtime compatibility target MUST align with the `@types/node` package major version used to validate sandboxed-node tests and type checks. Compatibility documentation and spec references MUST describe the same target major Node line.

#### Scenario: Current baseline is declared for contributors and users
- **WHEN** this requirement is applied for the current dependency baseline
- **THEN** compatibility docs and governance text MUST declare Node `22.x` as the active target line derived from `@types/node` `22.x`

#### Scenario: `@types/node` target major is upgraded
- **WHEN** the workspace intentionally upgrades `@types/node` to a new major version used by sandboxed-node validation
- **THEN** the same change MUST update `docs/node-compatability.mdx` and related compatibility-governance references to the new target Node major line

#### Scenario: Compatibility target is documented
- **WHEN** compatibility requirements or docs declare a target Node version
- **THEN** the declared target MUST match the active `@types/node` major version used by sandboxed-node validation workflows
