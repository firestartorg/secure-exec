# Cloudflare Dynamic Workers vs Secure Exec

Source: https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/

## What Dynamic Workers Are

CF's Worker Loader API lets a parent worker spawn child isolates on demand with arbitrary code. Primary use case: AI agent tool execution — chain multiple tool calls in isolated sandboxes without round-tripping through the LLM.

## API Surface

```js
// Parent worker
const stub = await env.LOADER.get(id, async () => ({
  modules: {
    "index.js": { esModule: `export default { async fetch(req, env) { ... } }` },
    "lib.js": { esModule: `export function helper() { ... }` },
  },
  bindings: { MY_KV: env.KV },       // inject capabilities
  globalOutbound: null,                // block all outbound network
  compatibilityDate: "2024-01-01",
}));

// Call the child
const response = await stub.fetch(request);

// Or use named entrypoints
const entrypoint = stub.getEntrypoint("MyHandler");
const result = await entrypoint.myMethod(args);
```

## Key Patterns

### 1. ID-based caching with lazy init

`get(id, callback)` returns a stub immediately. The callback only fires on first use for a given ID. Same ID = reuse the warm isolate. This means:
- Use `<name>:<version>` IDs for deterministic code — get free caching
- Use random IDs for dynamic/untrusted code — get guaranteed fresh isolates

### 2. Named entrypoints

A single worker can export multiple entrypoint classes. The host picks which to invoke:

```js
stub.getEntrypoint("default")  // default fetch handler
stub.getEntrypoint("Scheduler") // named entrypoint with custom methods
```

Each entrypoint class can have custom `ctx.props` for initialization.

### 3. Network policy as a handler

`globalOutbound` controls all outbound network. Options:
- Omit: normal internet access
- `null`: fully isolated, no outbound
- Service binding: route all outbound through another worker (proxy/log/transform)

### 4. Loopback bindings

Parent can expose capabilities back to the child via `ctx.exports`:

```js
// Child can call parent-provided services via env bindings
const result = await env.PARENT_SERVICE.fetch(request);
```

### 5. Module dictionary

Code is passed as a dictionary of named modules rather than a single string:

```js
modules: {
  "index.js": { esModule: "..." },
  "utils.js": { commonJsModule: "..." },
  "data.json": { json: "..." },
  "config.txt": { text: "..." },
}
```

## Comparison to Secure Exec

| Pattern | CF Dynamic Workers | Secure Exec | Gap? |
|---|---|---|---|
| Isolate reuse | ID-based caching via `get(id, cb)` | `NodeProcess` persists isolate, but clears module caches per `exec()` | **Yes** — module recompilation on every call |
| Named entrypoints | `getEntrypoint(name)` with custom methods | Single `exec(code)` / `run(code)` | **Yes** — no way to export multiple handlers from one module |
| Network policy | `globalOutbound` (null / handler / default) | `NetworkAdapter` + `Permissions.network` | No — `NetworkAdapter` is equivalent (the adapter IS the handler) |
| Capability injection | `bindings` + `ctx.exports` loopback | `SandboxDriver` + bridge References | No — same pattern, different API shape |
| Multi-file code | Module dictionary | `VirtualFileSystem` / `createInMemoryFileSystem()` | No — already supported, just more verbose |
| Lazy code loading | Callback only invoked on first use | Code always provided upfront | Minor — not a real limitation for our use case |

## What to Borrow

### Named entrypoints (high value)

This directly enables the Bun-style fetch handler on the wishlist. Instead of:

```js
// User has to wire up server boilerplate
const code = `
  const { serve } = require('@hono/node-server');
  const { Hono } = require('hono');
  const app = new Hono();
  app.get('/', (c) => c.text('hello'));
  serve({ fetch: app.fetch, port: 3000 });
`;
await process.exec(code);
```

The user exports a fetch handler and the host invokes it:

```js
// User code is just the handler
const code = `
  const { Hono } = require('hono');
  const app = new Hono();
  app.get('/', (c) => c.text('hello'));
  module.exports = { fetch: app.fetch };
`;
const worker = await process.run(code);
// Host calls the exported fetch directly
const response = await worker.exports.fetch(request);
```

### Module cache persistence (medium value)

Keep compiled ESM/CJS modules warm across `exec()` calls on the same `NodeProcess`. Useful for:
- HTTP servers handling many requests through the same isolate
- Repeated tool execution with the same dependencies
- Avoiding redundant compilation of large dependency trees

Currently `executeInternal()` clears `esmModuleCache` and `dynamicImportCache` on every call. A flag like `reuseModules: true` or scoping cache invalidation to code changes would help.

### Not worth borrowing

- **`globalOutbound`** — `NetworkAdapter` already serves this role
- **Loopback bindings** — `SandboxDriver` already serves this role
- **Module dictionary** — `createInMemoryFileSystem()` already covers this; could add a convenience constructor but not architectural
