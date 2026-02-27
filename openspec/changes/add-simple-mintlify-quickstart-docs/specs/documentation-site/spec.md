## ADDED Requirements

### Requirement: Single-Page Quickstart Navigation
The documentation site SHALL expose exactly one primary navigation page for initial rollout, and that page SHALL be the Quickstart page.

#### Scenario: Docs configuration defines only quickstart page
- **WHEN** the docs configuration is loaded
- **THEN** navigation MUST include `quickstart` as the only top-level page entry

#### Scenario: Quickstart page path is resolvable
- **WHEN** a user selects the Quickstart page from navigation
- **THEN** the docs site MUST resolve and render `quickstart.mdx` successfully

### Requirement: Quickstart Uses Steps With Runnable Example
The Quickstart page SHALL present onboarding steps using Mintlify `<Steps>` and SHALL include at least one basic runnable example that verifies setup success.

#### Scenario: Steps component structures onboarding
- **WHEN** the Quickstart page is rendered
- **THEN** the page MUST contain a `<Steps>` block with ordered setup actions

#### Scenario: Quickstart includes basic verification example
- **WHEN** a user follows the Quickstart page
- **THEN** the page MUST provide at least one concrete command example and expected successful outcome text
