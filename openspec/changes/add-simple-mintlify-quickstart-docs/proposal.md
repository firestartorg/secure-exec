## Why

The project does not have a simple, public quickstart docs entrypoint today, which makes first-run onboarding harder than it should be. A minimal Mintlify setup is needed now so new users can get from clone to first successful run with one page.

## What Changes

- Add a minimal Mintlify docs site scaffold under a new `docs/` directory.
- Publish a single Quickstart page as the only navigation entry.
- Use Mintlify `<Steps>` on the Quickstart page to present the startup flow in a short, ordered sequence.
- Include one basic runnable example in the Quickstart page so users can verify setup immediately.
- Keep scope intentionally narrow: no multi-page IA, no plugin/reference sections, and no extra theming work beyond required Mintlify config.

## Capabilities

### New Capabilities
- `documentation-site`: Defines the required minimal Mintlify docs surface for this repository, including one-page Quickstart navigation and a `<Steps>`-based onboarding flow with a basic example.

### Modified Capabilities
- None.

## Impact

- Affected code: new `docs/` Mintlify content and configuration files (for example `docs/docs.json` and `docs/quickstart.mdx`).
- Affected systems: project documentation publishing/hosting workflow for Mintlify content.
- No runtime, bridge, permission, or stdlib behavior changes.
