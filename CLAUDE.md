- commit your work along the way. do not push it. use branches as needed.
- use pnpm, vitest, and tsc for type checks
- do not use timeouts more than 10s
- use tsx to execute typescript code as needed
- wasmer sdk docs at https://wasmerio.github.io/wasmer-js/
- all bridge types that get injected in to ivm (isolated-vm) need to be defined in packages/nanosandbox/src/bridge/. they also need to be fully type checked agianst @tyeps/node with either `impelments` or `satisfies` or the equivalent
- do not implement polyfills yourself if it already exists in node-stdlib-browser (in node-process/polyfills.ts)
- when running tests, always write tests to a file then cat/grep/etc the file. this lets you read from the file multiple times while only running the expensive test once.
- use timeouts 1 minute or less. do not run all tests at once unless you're testing a large set of changes -- assume tests are slow.
- use turbo to do fresh builds instead of pnpm --filter build

## wasmer-js Filesystem Architecture

The wasmer-js SDK has two filesystem layers:

1. **TmpFileSystem** - Each Instance (spawned command) gets its own TmpFileSystem overlay. Files written via the Instance VFS API (vfsWriteFile, etc.) go to this Instance-specific TmpFileSystem. These files are NOT shared between Instances.

2. **Mounted Directory** - The Directory object mounted at /data is SHARED between all Instances. Files written to Directory are visible to all spawned commands at /data/*.

**Implication**: If you write files via VFS and then spawn a separate command (ls, cat, etc.), that command won't see the VFS files because it has its own TmpFileSystem. To test VFS operations with shell commands, use a shell script within a single spawn() call so all operations happen in the same Instance.

## wasmer-js Node.js Scheduler Issues

The wasmer-js SDK has several issues when running in Node.js:

1. **Event Loop**: The SDK's web-worker based threading doesn't properly keep the Node.js event loop alive. The `withEventLoopActive()` helper in `src/wasix/index.ts` works around this by using a `setInterval`.

2. **Scheduler Race Conditions**: Running more than ~2 WASM commands across separate test blocks causes the scheduler to hang. The third command will start but never complete. This appears to be a state management bug in the wasmer-js scheduler when the "idle" message is processed incorrectly.

3. **Directory Writes Between Commands**: Writing to a Directory object between WASM commands (within the same test) can cause hangs. Always write all files BEFORE running any commands.

**Workarounds in tests**:
- Keep each test to a single WASM command when possible
- Tests that run multiple commands in the same session may need to be skipped
- Add a `setInterval(() => {}, 1000)` keepAlive to test files that use wasmer-js

## sandboxed-node V8 Accelerator Architecture

When WASM code (bash, etc.) needs to run `node`, it uses the `host_exec` syscalls to delegate execution to the host. Instead of spawning a real Node.js process, we use sandboxed-node's `NodeProcess` which runs JavaScript in an isolated V8 context (via isolated-vm).

### Why?

1. **Security**: V8 isolates provide memory isolation without spawning real processes
2. **Performance**: No process spawn overhead, faster startup
3. **Control**: We control the sandbox environment (process.pid, env, filesystem)

### Architecture Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ WASM Worker (bash, etc.)                                            │
│                                                                     │
│   bash runs: node -e "console.log('hello')"                        │
│                    │                                                │
│                    ▼                                                │
│   wasix-runtime shim calls host_exec_start syscall                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                                        │
                    postMessage + SharedArrayBuffer sync
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Main Thread (nanosandbox)                                           │
│                                                                     │
│   hostExecHandler receives HostExecContext:                        │
│   - command: "node"                                                 │
│   - args: ["-e", "console.log('hello')"]                           │
│   - env, cwd, onStdout, onStderr, etc.                             │
│                    │                                                │
│                    ▼                                                │
│   Creates NodeProcess (sandboxed-node):                            │
│   - V8 isolate with memory limit                                    │
│   - ProcessConfig: pid, ppid, cwd, env, argv                       │
│   - Executes code via nodeProcess.exec()                           │
│                    │                                                │
│                    ▼                                                │
│   Streams stdout/stderr back via onStdout/onStderr callbacks       │
│   Returns exit code to WASM                                         │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Files

- `packages/nanosandbox/src/vm/index.ts` - hostExecHandler that creates NodeProcess
- `packages/sandboxed-node/src/index.ts` - NodeProcess class (V8 isolate wrapper)
- `packages/sandboxed-node/bridge/process.ts` - process object polyfill with configurable pid/ppid

### HostExecContext → ProcessConfig Binding

| HostExecContext | ProcessConfig | Notes |
|-----------------|---------------|-------|
| `ctx.cwd` | `processConfig.cwd` | Working directory |
| `ctx.env` | `processConfig.env` | Environment variables |
| `ctx.args` | `processConfig.argv` | Command line arguments |
| (generated) | `processConfig.pid` | Unique PID from counter |
| (hardcoded) | `processConfig.ppid` | Always 1 (WASM shell parent) |

### Current Limitations

1. **stdin not supported**: NodeProcess.exec() doesn't accept stdin (test skipped)
2. **File execution not supported**: `node script.js` requires VFS access which isn't passed through HostExecContext yet
3. **Only `node` command**: Other commands return error (only node is V8 accelerated)