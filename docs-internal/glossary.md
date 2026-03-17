# Glossary

- **Kernel** — the shared OS layer (`packages/kernel/`). Provides VFS, FD table, process table, device layer, pipes, command registry, and permissions. All runtimes share the same kernel instance.
- **Runtime Driver** — a pluggable execution engine (WasmVM, Node, Python) that implements the `RuntimeDriver` interface and mounts into the kernel. Registers commands and spawns processes.
- **WasmVM** — the BusyBox-style WASM binary runtime. Contains 90+ Unix commands compiled from Rust. Runs in Web Workers with WASI polyfill.
- **Isolate** — a V8 isolate. The unit of code execution and memory isolation. Each sandbox execution gets its own isolate.
- **Runtime** — the sandbox. The full `secure-exec` execution environment including the isolate, bridge, and resource controls.
- **Bridge** — the narrow layer between the isolate and the host that mediates all privileged operations. Untrusted code can only reach host capabilities through the bridge.
- **Driver** — a host-side capability provider (filesystem, network, process, env) that the bridge delegates to. Drivers are configured per-sandbox and enforce permission checks.
- **VFS** — virtual filesystem. The kernel's `VirtualFileSystem` interface, implemented by platform-specific backends (NodeFileSystem, InMemoryFileSystem).
- **FD Table** — per-PID file descriptor table. Maps FD numbers to `FileDescription` objects with shared cursor positions via dup/dup2.
- **Process Table** — tracks all processes across runtimes. Owns PID allocation, parent-child relationships, waitpid, and signal routing.
- **Command Registry** — maps command names to runtime drivers. Enables shell PATH lookup and cross-runtime command execution.
- **Device Layer** — intercepts `/dev/*` paths before they reach the VFS backend. Handles `/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`.
