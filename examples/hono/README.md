# Hono Sandbox Example

This example uses a loader/runner split:

- `loader/` runs sandboxed-node and executes the runner entry file.
- `runner/` contains a regular Hono app with package dependencies in `node_modules`.
- `loader/` verifies the running sandbox server by calling `sandbox.network.fetch(...)`
  (`NodeProcess.network.fetch(...)`) and then terminates the sandbox from the host.
- shared loader helpers live in `examples/shared/src/sandbox-runner-utils.ts`.

Run:

```bash
pnpm -C examples/hono/loader dev
```
