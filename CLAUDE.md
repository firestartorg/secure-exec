## Tooling

- use pnpm, vitest, and tsc for type checks
- use turbo for builds
- keep timeouts under 1 minute and avoid running full test suites unless necessary

## Bridge Policy

- bridge types injected into isolated-vm live under packages/sandboxed-node/src/bridge and should stay compatible with @types/node
- bridge scope is strict: bridge only Node.js built-in APIs/types (matching `@types/node`); never bridge third-party npm modules (for example `@hono/node-server`)
- third-party packages must run from sandboxed `node_modules` via normal module resolution/runtime behavior, not via bridge shims
- do not implement polyfills yourself if node-stdlib-browser already provides them
- never expose any new sandbox functionality/capability without explicit user approval and an agreed plan first

## Validation And Docs

- after modifying bridge files, run type conformance tests (`pnpm run check-types:test` in sandboxed-node)
- keep `docs-internal/node/STDLIB_COMPATIBILITY.md` up to date when changing bridge API surface
- track issues, workarounds, and unexpected friction encountered during development in the friction log at `docs-internal/friction/`. If an issue gets resolved, mark it as resolved in the log with a note on the fix.
- maintain `docs-internal/todo/sandboxed-node.md` during execution: check off completed items as they are finished, and add new todos immediately as they are discovered in discussion or implementation.

## Comment Pattern

Follow the style in `packages/sandboxed-node/src/index.ts`.

- use short phase comments above logical blocks
- explain intent/why, not obvious mechanics
- keep comments concise and consistent (`Set up`, `Transform`, `Wait for`, `Get`)
- comment tricky ordering/invariants; skip noise
