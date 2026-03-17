# Architecture Overview

```
                         Consumer API
                     createKernel() + mount()
                              │
                    ┌─────────┴─────────┐
                    │      Kernel        │  packages/kernel/
                    │  VFS, FD Table,    │
                    │  Process Table,    │
                    │  Device Layer,     │
                    │  Pipe Manager,     │
                    │  Command Registry, │
                    │  Permissions       │
                    └─────────┬──────────┘
                              │
               ┌──────────────┼──────────────┐
               │              │              │
          WasmVM          Node           Python
          Runtime         Runtime        Runtime
   packages/runtime/  packages/secure-exec/  packages/secure-exec/
       wasmvm/         src/node/             src/python/
```

## Kernel

`packages/kernel/src/`

The shared OS layer. Platform-agnostic — no Node.js or browser APIs. All runtimes make "syscalls" to the kernel for filesystem, process, pipe, and FD operations.

- `createKernel(options)` — creates a kernel with a VFS backend and optional permissions
- `kernel.mount(driver)` — mounts a runtime driver, registers its commands
- `kernel.exec(command)` — executes through the shell (requires WasmVM runtime)
- `kernel.spawn(command, args)` — spawns a process directly via command registry

### Kernel Components

- **VFS** (`vfs.ts`) — POSIX-complete `VirtualFileSystem` interface with symlinks, links, chmod/chown/utimes/truncate
- **FD Table** (`fd-table.ts`) — Per-PID file descriptors with shared FileDescriptions (cursor sharing via dup/dup2)
- **Process Table** (`process-table.ts`) — PID allocation, parent-child, waitpid, signal routing across runtimes
- **Device Layer** (`device-layer.ts`) — Intercepts /dev/null, /dev/zero, /dev/stdin, /dev/stdout, /dev/stderr, /dev/urandom
- **Pipe Manager** (`pipe-manager.ts`) — Cross-runtime pipe creation and buffered data flow
- **Command Registry** (`command-registry.ts`) — Command name → driver routing, /bin population for shell PATH lookup
- **Permissions** (`permissions.ts`) — Deny-by-default VFS permission wrapping
- **User** (`user.ts`) — User/group identity (uid, gid, getpwuid)

### RuntimeDriver Interface

```typescript
interface RuntimeDriver {
  name: string;
  commands: string[];
  init(kernel: KernelInterface): Promise<void>;
  spawn(command: string, args: string[], ctx: ProcessContext): DriverProcess;
  dispose(): Promise<void>;
}
```

## OS Layer

Platform-specific implementations of abstractions the kernel needs.

### os/node

`packages/os/node/src/`

- `NodeFileSystem` — implements `VirtualFileSystem` by delegating to `node:fs/promises`
- `NodeWorkerAdapter` — wraps `node:worker_threads`

### os/browser

`packages/os/browser/src/`

- `InMemoryFileSystem` — POSIX-complete in-memory VFS with symlinks, hard links, permissions
- `BrowserWorkerAdapter` — wraps Web Worker API

## WasmVM Runtime

`packages/runtime/wasmvm/src/` (TypeScript host) + `wasmvm/` (Rust workspace)

BusyBox-style WASM binary containing 90+ Unix commands (brush-shell, coreutils, grep, sed, awk, find, jq).

- `WasmOS` class — current standalone API (pre-kernel integration)
- WASI polyfill (46 syscalls) → translates WASI calls to VFS/FD/process operations
- Worker-based process model with SharedArrayBuffer + Atomics synchronization
- Ring buffers for WASM-to-WASM pipeline optimization

## Existing Runtime Architecture (packages/secure-exec)

The existing secure-exec package retains its full architecture. The kernel is additive.

### NodeRuntime / PythonRuntime

`src/runtime.ts`, `src/python-runtime.ts`

Public APIs. Thin facades that delegate orchestration to runtime drivers.

- `NodeRuntime.run(code)` — execute JS module, get exports back
- `PythonRuntime.run(code)` — execute Python and return structured value/global wrapper
- `exec(code)` — execute as script, get exit code/error contract
- `dispose()` / `terminate()`
- Requires both:
  - `systemDriver` for runtime capabilities/config
  - runtime-driver factory for runtime-driver construction

### TypeScript Tools

`packages/secure-exec-typescript/src/index.ts`

Optional companion package for sandboxed TypeScript compiler work (`@secure-exec/typescript`).

- `createTypeScriptTools(...)` — build project/source compile and typecheck helpers
- Uses a dedicated `NodeRuntime` compiler sandbox per request
- Keeps TypeScript compiler execution out of the core runtime path

### SystemDriver

`src/runtime-driver.ts` (re-exported from `src/types.ts`)

Config object that bundles what the sandbox can access. Deny-by-default.

- `filesystem` — VFS adapter
- `network` — fetch, DNS, HTTP
- `commandExecutor` — child processes
- `permissions` — per-adapter allow/deny checks

### NodeRuntimeDriverFactory / PythonRuntimeDriverFactory

Factory abstraction for constructing runtime drivers from normalized runtime options.

- `createRuntimeDriver(options)` — returns a `RuntimeDriver`

#### createNodeDriver()

`src/node/driver.ts`

Factory that builds a `SystemDriver` with Node-native adapters.

- Wraps filesystem in `ModuleAccessFileSystem` (read-only `node_modules` overlay)
- Optionally wires up network and command executor

#### createNodeRuntimeDriverFactory()

`src/node/driver.ts`

Factory that builds a Node-backed `RuntimeDriverFactory`.

- Constructs `NodeExecutionDriver` instances
- Owns optional Node-specific isolate creation hook

#### createBrowserDriver()

`src/browser/driver.ts`

Factory that builds a browser `SystemDriver` with browser-native adapters.

- Uses OPFS or in-memory filesystem adapters
- Uses fetch-backed network adapter with deterministic `ENOSYS` for unsupported DNS/server paths
- Applies permission wrappers before returning the driver

#### createBrowserRuntimeDriverFactory()

`src/browser/runtime-driver.ts`

Factory that builds a browser-backed `RuntimeDriverFactory`.

- Validates and rejects Node-only runtime options
- Constructs `BrowserRuntimeDriver` instances
- Owns worker URL/runtime-driver creation options

#### createPyodideRuntimeDriverFactory()

`src/python/driver.ts`

Factory that builds a Python-backed `PythonRuntimeDriverFactory`.

- Constructs `PyodideRuntimeDriver` instances
- Owns Pyodide worker bootstrap and runtime-driver creation options

### NodeExecutionDriver

`src/node/execution-driver.ts`

The engine. Owns the `isolated-vm` isolate and bridges host capabilities in.

- Creates contexts, compiles ESM/CJS, runs code
- Bridges fs, network, child_process, crypto, timers into the isolate via `ivm.Reference`
- Caches compiled modules and resolved formats per isolate
- Enforces payload size limits on bridge transfers

### BrowserRuntimeDriver

`src/browser/runtime-driver.ts`

Browser execution driver that owns worker lifecycle and message marshalling.

- Spawns and manages the browser runtime worker
- Dispatches `run`/`exec` requests and correlates responses by request ID
- Streams optional stdio events to host hooks without runtime-managed output buffering
- Exposes the configured browser network adapter through `NodeRuntime.network`

### Browser Worker Runtime

`src/browser/worker.ts`

Worker-side runtime implementation used by the browser runtime driver.

- Initializes browser bridge globals and runtime config from worker init payload
- Executes transformed CJS/ESM user code and returns runtime-contract results
- Uses permission-aware filesystem/network adapters in the worker context
- Preserves deterministic unsupported-operation contracts (for example DNS gaps)

### PyodideRuntimeDriver

`src/python/driver.ts`

Python execution driver that owns a Node worker running Pyodide.

- Loads Pyodide once per runtime instance and keeps interpreter state warm across runs
- Dispatches `run`/`exec` requests and correlates responses by request ID
- Streams stdio events to host hooks without runtime-managed output buffering
- Uses worker-to-host RPC for permission-wrapped filesystem/network access through `SystemDriver`
- Restarts worker state on execution timeout to preserve deterministic recovery behavior

### ModuleAccessFileSystem

`src/node/module-access.ts`

Filesystem overlay that makes host `node_modules` available read-only at `/root/node_modules`.

- Blocks `.node` native addons
- Prevents symlink escapes (resolves pnpm virtual-store paths)
- Non-module paths fall through to base VFS

### Permissions

`src/shared/permissions.ts`

Wraps each adapter with allow/deny checks before calls reach the host.

- `wrapFileSystem()`, `wrapNetworkAdapter()`, `wrapCommandExecutor()`
- Missing adapters get deny-all stubs
