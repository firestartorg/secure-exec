## MODIFIED Requirements

### Requirement: Single-Page Quickstart Navigation
The documentation site SHALL expose a core navigation set that includes Quickstart, Security Model, and Node Compatibility pages for initial rollout.

#### Scenario: Docs configuration defines required core pages
- **WHEN** the docs configuration is loaded
- **THEN** navigation MUST include `quickstart`, `security-model`, and `node-compatability` as available documentation pages

#### Scenario: Node compatibility page path is resolvable
- **WHEN** a user selects the Node Compatibility page from navigation
- **THEN** the docs site MUST resolve and render `node-compatability.mdx` successfully

## ADDED Requirements

### Requirement: Node Compatibility Page Declares Target Version and Matrix
The docs site MUST provide `docs/node-compatability.mdx` with an explicit target Node version statement near the top of the page and a clean compatibility matrix table that summarizes module support tier and runtime notes.

#### Scenario: Target Node version is visible at top of page
- **WHEN** `node-compatability.mdx` is rendered
- **THEN** users MUST see the targeted Node version before the compatibility matrix content

#### Scenario: Compatibility matrix uses concise tabular format
- **WHEN** `node-compatability.mdx` is rendered
- **THEN** it MUST include a simple table with module/support-tier/status details migrated from the internal compatibility source

#### Scenario: Permission model scope stays at runtime and bridge contract
- **WHEN** `node-compatability.mdx` documents permission behavior
- **THEN** it MUST describe core runtime/bridge permission enforcement and MUST NOT present driver-construction convenience defaults as the canonical security contract
