# Node.js Polyfill Libraries for isolated-vm (V8 Isolates)

## Executive Summary

When running JavaScript code in isolated-vm (V8 isolates), you're limited to pure ECMAScript with no access to Node.js stdlib or browser APIs. This research identifies polyfill libraries that provide Node.js core module functionality using pure JavaScript (no native bindings), suitable for sandboxed execution environments.

## Key Constraint: isolated-vm Limitations

isolated-vm isolates are completely separate V8 environments with:
- Only pure ECMAScript support by default
- No access to Node.js `require()` function
- No access to Node.js core modules (fs, http, net, etc.)
- No native bindings allowed
- All code must be transferred via `ExternalCopy` or similar mechanisms

**Solution approaches:**
1. Bundle polyfills with webpack/rollup/esbuild before transferring to isolate
2. Create a custom require-like system with whitelisted modules
3. Manually inject polyfilled modules into the isolate context

---

## Polyfill Library Options

### 1. node-stdlib-browser (Recommended for Comprehensive Coverage)

**Package:** `node-stdlib-browser`
**GitHub:** https://github.com/niksy/node-stdlib-browser
**Suitability for isolated-vm:** ✅ Excellent - Pure JS implementations

**Coverage:** Comprehensive - 30+ modules including:
- `assert`, `buffer`, `console`, `constants`, `crypto`
- `domain`, `events`, `http`, `https`, `os`
- `path`, `punycode`, `process`, `querystring`
- `stream`, `_stream_duplex`, `_stream_passthrough`, `_stream_readable`, `_stream_transform`, `_stream_writable`
- `string_decoder`, `timers`, `tty`, `url`, `util`, `vm`, `zlib`

**Key Features:**
- Exports absolute paths to each module directory
- Supports `node:` protocol imports
- Provides mocks for unsupported modules (returns null)
- No `fs` implementation (intentional - multiple possible implementations)
- IE11+ browser support (most modules work in IE9+)
- TypeScript support via `@types/node`

**Individual Packages Used:**
```
assert
buffer
browserify-zlib
console-browserify
constants-browserify
crypto-browserify
domain-browser
events
https-browserify
os-browserify
path-browserify
process
punycode
querystring-es3
readable-stream (for stream modules)
stream-browserify
stream-http
string_decoder
timers-browserify
tty-browserify
url
util
vm-browserify
```

**Usage for isolated-vm:**
Bundle the required modules with webpack/rollup before injecting into isolate:
```javascript
// Bundle with webpack/rollup to get standalone JS
// Then inject into isolate
const bundledCode = fs.readFileSync('bundled-polyfills.js', 'utf8');
await isolate.compileScript(bundledCode).then(script => script.run(context));
```

---

### 2. Individual Browserify Polyfills (Modular Approach)

**Suitability for isolated-vm:** ✅ Excellent - Pure JS, no native bindings

**Complete Package List:**

| Node.js Module | NPM Package | Pure JS? |
|----------------|-------------|----------|
| `assert` | `assert` | ✅ Yes |
| `buffer` | `buffer` | ✅ Yes |
| `console` | `console-browserify` | ✅ Yes |
| `constants` | `constants-browserify` | ✅ Yes |
| `crypto` | `crypto-browserify` | ✅ Yes (partial - some algorithms) |
| `domain` | `domain-browser` | ✅ Yes |
| `events` | `events` | ✅ Yes |
| `http` | `stream-http` | ✅ Yes |
| `https` | `https-browserify` | ✅ Yes |
| `os` | `os-browserify` | ✅ Yes (mocked) |
| `path` | `path-browserify` | ✅ Yes |
| `process` | `process` | ✅ Yes (mocked globals) |
| `punycode` | `punycode` | ✅ Yes |
| `querystring` | `querystring-es3` | ✅ Yes |
| `stream` | `stream-browserify` | ✅ Yes |
| `string_decoder` | `string_decoder` | ✅ Yes |
| `sys` | `util` | ✅ Yes |
| `timers` | `timers-browserify` | ✅ Yes |
| `tty` | `tty-browserify` | ✅ Yes (mocked) |
| `url` | `url` | ✅ Yes |
| `util` | `util` | ✅ Yes |
| `vm` | `vm-browserify` | ✅ Yes |
| `zlib` | `browserify-zlib` | ✅ Yes |

**Advantages:**
- Cherry-pick only needed modules
- Well-maintained individual packages
- Used by browserify ecosystem (battle-tested)
- Tree-shakeable when bundled properly

**Notes:**
- `crypto-browserify`: Partial implementation, not all algorithms supported
- `stream` modules: Complex circular dependencies, hard to tree-shake
- Simple modules like `path`, `events`, `util`, `process` tree-shake very well
- Must be bundled before use in isolated-vm

---

### 3. unenv (Modern Edge Runtime Solution)

**Package:** `unenv`
**GitHub:** https://github.com/unjs/unenv
**Suitability for isolated-vm:** ✅ Good - Designed for edge runtimes

**Description:**
Node.js compatibility for any JavaScript runtime, including browsers and edge workers. Used by Cloudflare Workers, Nuxt, and Nitro.

**Key Features:**
- Smart polyfilling: Only includes polyfills you actually use
- Configurable presets (Cloudflare, Vercel Edge, custom)
- Mocking for unsupported APIs (prevents import errors)
- Integration with modern bundlers (Rollup, Vite, esbuild, webpack)
- `defineEnv` utility for generating environment configs

**Coverage:**
- Comprehensive Node.js API coverage
- Automatic detection of used APIs
- Mocks for unsupported APIs (no-ops or throw errors)
- Supports `node:` protocol imports

**Usage Pattern:**
```javascript
import { defineEnv } from 'unenv';

const env = defineEnv({
  nodeCompat: true,  // Add aliases for Node.js builtins
  npmShims: true,    // Replace heavy packages with lighter shims
});

// Use with bundler to create isolated-vm compatible bundle
```

**Advantages for isolated-vm:**
- Smaller bundle sizes (only includes what's used)
- Modern, actively maintained
- Designed for sandboxed environments
- Good for dynamic/runtime polyfill injection

---

### 4. vite-plugin-node-polyfills / rollup-plugin-polyfill-node

**Packages:**
- `vite-plugin-node-polyfills` (for Vite)
- `rollup-plugin-polyfill-node` (for Rollup)
- `node-polyfill-webpack-plugin` (for Webpack 5+)

**Suitability for isolated-vm:** ✅ Good - Bundler integration

**Description:**
Bundler plugins that use `node-stdlib-browser` under the hood to automatically inject polyfills.

**Coverage:**
Same as `node-stdlib-browser` plus:
- `child_process` (mocked)
- `cluster` (mocked)
- `dgram` (mocked)
- `dns` (mocked)
- `fs` (can be configured with virtual FS like `memfs`)
- `http2` (mocked)
- `module` (mocked)
- `net` (mocked)
- `readline` (mocked)
- `repl` (mocked)
- `timers/promises`
- `tls` (mocked)

**Usage for isolated-vm:**
Use during build step to create bundled code:
```javascript
// vite.config.js
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default {
  plugins: [
    nodePolyfills({
      // Specific globals to polyfill
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
};
```

Then bundle and inject the output into isolated-vm.

---

### 5. quickjs-emscripten with @sebastianwessel/quickjs

**Package:** `@sebastianwessel/quickjs`
**GitHub:** https://github.com/sebastianwessel/quickjs
**Suitability for isolated-vm:** ⚠️ Alternative runtime (not for isolated-vm)

**Description:**
While not directly usable in isolated-vm, this is worth noting as an alternative sandboxed JavaScript runtime that comes with built-in Node.js-like polyfills.

**Built-in Support:**
- `node:fs` (virtual file system)
- `node:assert`
- `node:util`
- `node:path`
- Fetch API
- Custom modules

**Note:** This uses QuickJS compiled to WebAssembly, not V8 isolates. Mentioned here for completeness as an alternative approach to sandboxed JavaScript execution.

---

## Modules NOT Available (Require Native Bindings)

These modules cannot work in isolated-vm without a bridge/shim to the main isolate:

- `fs` - File system (requires I/O access)
- `net` - Network sockets (requires system calls)
- `dgram` - UDP sockets (requires system calls)
- `dns` - DNS lookups (requires system calls)
- `http` (real) - Requires `net` module
- `https` (real) - Requires `net` and `crypto` native
- `child_process` - Process spawning (requires OS access)
- `cluster` - Process clustering (requires OS access)
- `tls` - TLS/SSL (requires native crypto)
- `readline` - TTY interaction (requires system access)
- `repl` - Read-Eval-Print Loop (requires full Node.js context)

**Solution for isolated-vm:**
Create delegate functions in the main isolate that the sandbox can call via `Reference` objects:

```javascript
// In main isolate
const readFile = new ivm.Reference(async (path) => {
  return await fs.promises.readFile(path, 'utf8');
});

// Transfer to sandbox
await context.global.set('readFile', readFile);

// In sandbox
const content = await readFile.derefInto()('/path/to/file');
```

---

## Recommended Approach for isolated-vm

### Strategy 1: Bundle Pure Polyfills (Recommended)

1. **Install polyfill collection:**
   ```bash
   npm install node-stdlib-browser
   ```

2. **Create a polyfill bundle:**
   ```javascript
   // polyfills.js
   export { default as buffer } from 'node-stdlib-browser/node_modules/buffer';
   export { default as events } from 'node-stdlib-browser/node_modules/events';
   export { default as util } from 'node-stdlib-browser/node_modules/util';
   export { default as path } from 'node-stdlib-browser/node_modules/path-browserify';
   export { default as stream } from 'node-stdlib-browser/node_modules/stream-browserify';
   export { default as process } from 'node-stdlib-browser/node_modules/process';
   // ... other modules
   ```

3. **Bundle with webpack/rollup/esbuild:**
   ```javascript
   // webpack.config.js
   module.exports = {
     entry: './polyfills.js',
     output: {
       filename: 'polyfills.bundle.js',
       library: 'NodePolyfills',
       libraryTarget: 'var',
     },
     mode: 'production',
   };
   ```

4. **Inject into isolated-vm:**
   ```javascript
   const ivm = require('isolated-vm');
   const fs = require('fs');

   const isolate = new ivm.Isolate({ memoryLimit: 128 });
   const context = await isolate.createContext();

   // Load polyfills
   const polyfillsCode = fs.readFileSync('polyfills.bundle.js', 'utf8');
   await isolate.compileScript(polyfillsCode).then(s => s.run(context));

   // Now user code can access polyfills
   const userCode = `
     const { Buffer } = NodePolyfills.buffer;
     const EventEmitter = NodePolyfills.events.EventEmitter;
     // User code here
   `;
   await isolate.compileScript(userCode).then(s => s.run(context));
   ```

### Strategy 2: Custom Require System

Build a require()-like function that maps module names to bundled polyfills:

```javascript
// In main isolate
const moduleMap = {
  buffer: bufferPolyfillCode,
  events: eventsPolyfillCode,
  path: pathPolyfillCode,
  // ...
};

const requireShim = `
  const require = (function() {
    const cache = {};
    const modules = ${JSON.stringify(moduleMap)};

    return function require(name) {
      if (cache[name]) return cache[name];
      if (!modules[name]) throw new Error('Module not found: ' + name);

      const module = { exports: {} };
      const fn = new Function('module', 'exports', 'require', modules[name]);
      fn(module, module.exports, require);

      cache[name] = module.exports;
      return cache[name];
    };
  })();
`;

await isolate.compileScript(requireShim).then(s => s.run(context));
```

---

## Performance Considerations

1. **Bundle size:** Stream modules (`stream`, `http`) have heavy circular dependencies
   - Best: `path`, `events`, `util`, `querystring` (< 10KB each)
   - Medium: `buffer`, `crypto-browserify` (50-200KB)
   - Heavy: `stream-http`, `browserify-zlib` (100-500KB)

2. **Tree shaking:** Use modern bundlers with proper exports
   - Named imports tree-shake better than default imports
   - Some modules (streams) cannot be tree-shaken effectively

3. **Isolate memory limits:** Be mindful of isolate memory constraints
   - Set appropriate `memoryLimit` when creating isolate
   - Monitor heap usage with `isolate.getHeapStatistics()`

---

## Security Considerations

1. **No automatic file system access:** `fs` polyfills require explicit bridges
2. **No network access:** `http`/`https` polyfills are stubs without network capabilities
3. **Process isolation:** `process` polyfills provide environment info but no OS access
4. **Crypto limitations:** `crypto-browserify` implements some algorithms in pure JS but may be slower/less secure than native
5. **Reference leakage:** Never expose `ivm.Reference` objects to untrusted code

---

## References

### Documentation
- [isolated-vm on GitHub](https://github.com/laverdet/isolated-vm)
- [isolated-vm on npm](https://www.npmjs.com/package/isolated-vm)
- [Node.js VM Documentation](https://nodejs.org/api/vm.html)

### Polyfill Libraries
- [node-stdlib-browser on GitHub](https://github.com/niksy/node-stdlib-browser)
- [node-stdlib-browser on npm](https://www.npmjs.com/package/node-stdlib-browser)
- [unenv on GitHub](https://github.com/unjs/unenv)
- [vite-plugin-node-polyfills](https://www.npmjs.com/package/vite-plugin-node-polyfills)
- [rollup-plugin-polyfill-node](https://www.npmjs.com/package/rollup-plugin-polyfill-node)

### Individual Browserify Polyfills
- [crypto-browserify](https://www.npmjs.com/package/crypto-browserify) | [GitHub](https://github.com/browserify/crypto-browserify)
- [stream-browserify](https://www.npmjs.com/package/stream-browserify) | [GitHub](https://github.com/browserify/stream-browserify)
- [Browserify Homepage](https://browserify.org/)

### Webpack/Build Tools
- [Webpack 5 Node Polyfills Upgrade Cheatsheet](https://gist.github.com/ef4/d2cf5672a93cf241fd47c020b9b3066a)
- [How to polyfill node core modules in webpack 5](https://www.alchemy.com/blog/how-to-polyfill-node-core-modules-in-webpack-5)
- [node-polyfill-webpack-plugin](https://www.npmjs.com/package/node-polyfill-webpack-plugin)

### Edge Runtimes & Cloudflare
- [Cloudflare Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [More NPM packages on Cloudflare Workers](https://blog.cloudflare.com/more-npm-packages-on-cloudflare-workers-combining-polyfills-and-native-code/)

### Alternative Runtimes
- [quickjs-emscripten](https://www.npmjs.com/package/quickjs-emscripten) | [GitHub](https://github.com/justjake/quickjs-emscripten)
- [@sebastianwessel/quickjs](https://github.com/sebastianwessel/quickjs)

### Additional Resources
- [Sandboxing NodeJS is hard](https://pwnisher.gitlab.io/nodejs/sandbox/2019/02/21/sandboxing-nodejs-is-hard.html)
- [Temporal's Introduction to Isolated VM](https://temporal.io/blog/intro-to-isolated-vm)
- [Edge Runtime: V8 Isolates Explained](https://medium.com/@jade.awesome.fisher/edge-runtime-its-not-magic-it-s-v8-isolates-c07c7547bea2)

---

## Conclusion

**Best option for isolated-vm:** Use `node-stdlib-browser` as your polyfill collection and bundle the required modules with webpack/rollup/esbuild before injecting into isolates. This provides:

✅ Comprehensive coverage (30+ modules)
✅ Pure JavaScript (no native bindings)
✅ Battle-tested (used across browserify ecosystem)
✅ Modular (cherry-pick what you need)
✅ Modern bundler support

For modules requiring I/O or system access (fs, net, http, etc.), implement delegate functions in the main isolate and expose them to the sandbox via `ivm.Reference` objects.
