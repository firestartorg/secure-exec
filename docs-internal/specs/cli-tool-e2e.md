# Spec: CLI Tool E2E Testing (Pi + Claude Code + OpenCode)

## Status

Draft

## Motivation

secure-exec emulates Node.js inside an isolated-vm sandbox. The project-matrix
test suite validates parity with host Node for library-level projects (Express,
Fastify, dotenv, semver), but no test exercises a real-world **interactive CLI
tool** end-to-end. Proving that production AI coding agents — Pi, Claude Code,
and OpenCode — can boot, process a prompt, and produce correct output inside the
sandbox is the strongest possible validation of the emulation layer.

Three dimensions need coverage:

1. **Headless mode** — all three tools support non-interactive prompt execution
   (`pi --print`, `claude -p`, `opencode run`). This tests the stdio pipeline,
   child_process spawning, fs operations, network (HTTPS to LLM APIs), and
   module loading without any terminal concerns.

2. **PTY/interactive mode** — all three tools render TUIs (Pi uses a custom
   differential-rendering TUI; Claude Code uses Ink; OpenCode uses OpenTUI
   with SolidJS). Running them through `kernel.openShell()` with a headless
   xterm verifies that PTY echo, escape sequences, cursor control, and signal
   delivery work correctly for real applications, not just synthetic tests.

3. **Binary-as-child-process mode** — OpenCode ships as a self-contained Bun
   binary rather than a Node.js package. It exercises a different sandbox path:
   the binary runs on the host via `child_process.spawn`, testing stdio piping,
   environment variable forwarding, and exit code propagation for complex
   real-world binaries.

## Tools under test

### Pi (`@mariozechner/pi-coding-agent`)

- **Runtime**: Pure TypeScript/Node.js — no native addons
- **Modes**: Interactive TUI, print/JSON, RPC (JSONL over stdin/stdout), SDK
- **Built-in tools**: read, write, edit, bash (synchronous child_process)
- **TUI**: Custom `pi-tui` library with retained-mode differential rendering,
  synchronized output sequences (`CSI ?2026h` / `CSI ?2026l`)
- **Dependencies**: `pi-ai` (LLM API), `pi-agent-core` (agent loop), `pi-tui`
- **LLM providers**: Anthropic, OpenAI, Google, xAI, Groq, Cerebras, OpenRouter
- **Session storage**: JSONL files in `~/.pi/agent/sessions/`
- **Why test first**: Pure JS, no native binary, simplest dependency tree

### Claude Code (`@anthropic-ai/claude-code`)

- **Runtime**: Node.js with bundled native binary components
- **Modes**: Interactive TUI (Ink-based), headless (`-p` flag)
- **Built-in tools**: Bash, Read, Edit, Write, Grep, Glob, Agent, WebFetch
- **Output formats**: text, json, stream-json (NDJSON)
- **Node.js requirement**: 18+ (22 LTS recommended)
- **npm status**: Deprecated in favor of native installer, but npm package
  still works — entry point is `sdk.mjs`
- **Known issue**: Spawning from Node.js child_process can stall
  (anthropics/claude-code#771)
- **Why test last**: Most complex in-VM tool, native binary concerns, known spawn issues

### OpenCode (`opencode-ai`)

- **Runtime**: Self-contained **Bun binary** — not a Node.js package
- **Architecture**: TypeScript compiled via `bun build --compile` into a
  standalone executable. npm package ships platform-specific binaries
  (`opencode-linux-x64`, `opencode-darwin-arm64`, etc.)
- **Modes**: Interactive TUI (default), headless run (`opencode run "prompt"`),
  server (`opencode serve`), web UI, attach, ACP server
- **Built-in tools**: Bash (via `Bun.spawn`), Read, Edit, Write, Grep, Glob,
  LSP integration, Git operations
- **TUI**: OpenTUI framework (TypeScript + Zig bindings) with SolidJS reactivity
- **Dependencies**: Vercel AI SDK (75+ LLM providers), Hono (HTTP server),
  Drizzle ORM + `bun:sqlite` (session persistence), Effect (structured
  concurrency), Shiki (syntax highlighting), tree-sitter (bash command security)
- **LLM providers**: Anthropic, OpenAI, Google Gemini, AWS Bedrock, Groq,
  Azure, OpenRouter, GitHub Copilot, and any OpenAI-compatible endpoint
- **Session storage**: SQLite database via `bun:sqlite` at
  `~/.local/share/opencode/`
- **Output formats**: text, JSON (via `--format` flag on `opencode run`)
- **SDK**: `@opencode-ai/sdk` — pure TypeScript HTTP client for programmatic
  access to `opencode serve`
- **Why test second**: Hardest overall — requires a different sandbox strategy
  (binary spawning vs in-VM execution) and exercises untested child_process
  paths for non-trivial host binaries. Tackling it before Claude Code front-loads
  the highest-risk work

**Key architectural difference**: Pi and Claude Code run as Node.js code inside
the isolate VM. OpenCode runs as a host binary spawned via the sandbox's
`child_process.spawn` bridge. This exercises a fundamentally different code
path and tests the sandbox's ability to manage, communicate with, and clean up
complex external processes.

## Prerequisites

This spec assumes the following are already implemented and working:

- PTY line discipline (echo, canonical mode, signal chars) — kernel
- `openShell()` / `connectTerminal()` — kernel
- `TerminalHarness` with headless xterm — from terminal-e2e-testing.md spec
- `child_process.spawn/exec` bridge — secure-exec
- `fs` bridge (read, write, stat, mkdir, readdir) — secure-exec
- HTTP/HTTPS client bridge (fetch, http.request) — secure-exec
- Environment variable passthrough — secure-exec
- Module loading (ESM/CJS with node_modules overlay) — secure-exec

## Node.js API requirements by tool

### Pi — critical path APIs

| API | Usage | Current support |
|-----|-------|----------------|
| `child_process.spawn` | Bash tool execution | Bridge: yes |
| `child_process.execSync` | Synchronous bash | Bridge: yes |
| `fs.*` (read/write/stat/mkdir/readdir) | Read/write tools | Bridge: yes |
| `process.stdin` / `process.stdout` | Terminal I/O | Bridge: yes |
| `process.stdout.isTTY` | Mode detection | Bridge: always `false` |
| `process.stdin.setRawMode()` | Raw keystroke input | Bridge: stub |
| `process.stdout.columns` / `rows` | Terminal dimensions | Bridge: `80`/`24` |
| `https` / `fetch` | LLM API calls | Bridge: partial |
| `path`, `url`, `util` | General utilities | Bridge: yes |
| `os.homedir()` | Session storage path | Bridge: yes |
| `crypto.randomUUID()` | Session IDs | Bridge: yes |

### Claude Code — critical path APIs

| API | Usage | Current support |
|-----|-------|----------------|
| `child_process.spawn` | Bash/tool execution | Bridge: yes |
| `fs.*` (full suite) | Read/Edit/Write tools | Bridge: partial |
| `process.stdin` / `process.stdout` | Terminal I/O | Bridge: yes |
| `process.stdout.isTTY` | Interactive vs headless | Bridge: always `false` |
| `process.stdin.setRawMode()` | Ink TUI raw input | Bridge: stub |
| `net.createConnection` | API client sockets | Bridge: deferred |
| `https.request` | Anthropic API calls | Bridge: partial |
| `tty.isatty()` | TTY detection | Polyfill: always `false` |
| `stream` (Transform, PassThrough) | SSE event parsing | Bridge: partial |
| `readline` | Input handling | Bridge: deferred |
| Environment variables | `ANTHROPIC_API_KEY` | Bridge: yes (filtered) |

### OpenCode — critical path APIs

OpenCode does not run inside the VM, so these are requirements on the
**child_process bridge** and **SDK client** (if testing via `@opencode-ai/sdk`):

| API | Usage | Current support |
|-----|-------|----------------|
| `child_process.spawn` | Spawning `opencode run` binary | Bridge: yes |
| `child_process.spawn` stdio piping | stdin/stdout/stderr for headless I/O | Bridge: yes |
| Environment variable forwarding | `ANTHROPIC_API_KEY`, provider config | Bridge: yes (filtered) |
| Exit code propagation | Detecting success/failure of binary | Bridge: yes |
| `http`/`fetch` (for SDK path) | `@opencode-ai/sdk` → `opencode serve` | Bridge: partial |
| SSE client (for SDK path) | Streaming responses from serve API | Bridge: partial |
| Signal forwarding | `SIGINT`/`SIGTERM` to spawned binary | Bridge: partial |
| `fs.*` (read/write/stat) | Verifying files created by OpenCode tools | Bridge: yes |

### OpenCode SDK (`@opencode-ai/sdk`) — critical path APIs

If testing via the SDK client running inside the sandbox:

| API | Usage | Current support |
|-----|-------|----------------|
| `fetch` / `http.request` | HTTP calls to `opencode serve` | Bridge: partial |
| `EventSource` / SSE parsing | Streaming responses | Not in bridge |
| `URL` / `URLSearchParams` | API endpoint construction | Bridge: yes |
| `AbortController` | Request cancellation | Bridge: yes |
| `JSON.parse`/`stringify` | Response parsing | Bridge: yes |

## Gap analysis

### Blocking for headless mode

1. **HTTPS client reliability** — Both tools make HTTPS requests to LLM APIs.
   The current `https` bridge wraps `http` but TLS handshake, certificate
   validation, and keep-alive behavior need verification under real API load.

2. **`process.stdout.isTTY` must be controllable** — Both tools check `isTTY`
   to decide mode. For headless testing this is fine (`false` → headless), but
   for PTY testing we need to set it to `true`. The bridge currently hardcodes
   `false`.

3. **Stream Transform/PassThrough** — Claude Code's SSE parser uses Node.js
   Transform streams. Pi's RPC mode uses JSONL stream parsing. Both need
   working stream piping.

4. **`fs.mkdirSync` with `recursive: true`** — Both tools create directory
   structures for sessions/config on startup.

### Blocking for PTY/interactive mode

5. **`process.stdout.isTTY = true` when attached to PTY** — When the sandbox
   process is spawned from `openShell()` with a PTY slave as its stdio, the
   bridge must report `isTTY = true` so the tool enters interactive mode.

6. **`process.stdin.setRawMode()`** — Pi's TUI and Claude Code's Ink both call
   `setRawMode(true)` on stdin. The bridge currently stubs this. When running
   under a PTY, this should configure the PTY line discipline (disable
   canonical mode, disable echo).

7. **ANSI escape sequence passthrough** — Pi uses synchronized output
   (`CSI ?2026h`/`CSI ?2026l`) and differential rendering. Claude Code's Ink
   uses cursor movement, screen clearing, and color codes. All must pass
   through the PTY untouched.

8. **Terminal dimensions query** — Both tools read `process.stdout.columns`
   and `process.stdout.rows`. Under PTY, these must reflect the actual PTY
   dimensions and update on `SIGWINCH`.

9. **Signal delivery through PTY** — `^C` must reach the tool as `SIGINT`
   through the PTY line discipline (already implemented in kernel).

### Blocking for OpenCode (binary spawn path)

10. **Signal forwarding to spawned binaries** — `SIGINT`/`SIGTERM` must be
    deliverable to the OpenCode binary spawned via `child_process.spawn`.
    The bridge currently supports basic signal delivery but needs verification
    with long-running processes that have their own signal handlers.

11. **Large stdout buffering for binary output** — `opencode run` may produce
    significant stdout output (tool results, streaming text). The bridge must
    handle this without truncation or backpressure deadlocks.

12. **Binary PATH resolution** — `child_process.spawn('opencode', ...)` must
    resolve the binary from the host `PATH`. The bridge's PATH handling needs
    verification for globally-installed npm/bun binaries.

### Blocking for OpenCode SDK path

13. **SSE/EventSource client** — `@opencode-ai/sdk` consumes Server-Sent
    Events from `opencode serve`. The bridge needs either `EventSource` support
    or working SSE parsing over `fetch` readable streams.

### Non-blocking but desirable

14. **`net.createConnection`** — Claude Code may use raw sockets for API
    connections in some paths. Currently deferred in bridge.

15. **`readline` module** — Some CLI tools use readline for line input. Currently
    deferred in bridge. Not needed for Pi or Claude Code headless mode.

16. **`worker_threads`** — Neither tool uses workers in the critical path, but
    some dependencies might attempt to import it.

## Test architecture

### Fixture approach: NOT project-matrix

The project-matrix pattern (run identical code in host Node and sandbox,
compare stdout) does **not** work here because:

- All three tools make network calls to LLM APIs — responses are non-deterministic
- Interactive mode produces terminal-specific output that varies by environment
- The goal is "does it boot and produce output," not "byte-for-byte parity"

Instead, use **dedicated test files** with mocked LLM backends and targeted
assertions.

### Two sandbox strategies

**In-VM execution** (Pi, Claude Code): The tool's JavaScript runs inside the
isolate VM. Module loading, fs, network, and child_process all go through the
bridge. This is the deepest emulation test.

**Binary spawn** (OpenCode): The tool runs as a native binary on the host,
spawned via the sandbox's `child_process.spawn` bridge. The sandbox controls
environment, stdio, and lifecycle. An optional second strategy uses
`@opencode-ai/sdk` running inside the VM to talk to `opencode serve` on the
host — this tests the HTTP/SSE client bridge.

### LLM API mocking strategy

All three tools need an LLM API to function. Options:

1. **Environment variable override** — Set `ANTHROPIC_API_KEY` /
   `OPENAI_API_KEY` to point at a local mock HTTP server running on the host.
   Override the base URL via environment variables that all tools support
   (`ANTHROPIC_BASE_URL`, Pi's provider config, OpenCode's provider
   `baseURL` in `opencode.json`).

2. **VFS-based response stubs** — Pre-seed the VFS with canned API responses.
   Mock the network bridge to return them. Simpler but less realistic.

3. **Real API with budget guard** — Use real API keys with strict
   `max_tokens: 10` to get minimal real responses. Most realistic but requires
   secrets in CI and costs money.

**Recommended**: Option 1 (mock HTTP server) for CI, Option 3 (real API) for
manual validation. The mock server can be a simple Express/Fastify fixture
running on the host, serving canned SSE responses.

### Mock LLM server

A minimal HTTP server that serves both Anthropic and OpenAI-compatible chat
completion responses. OpenCode uses the Vercel AI SDK which speaks the
OpenAI chat completions protocol, so the mock must handle both formats:

```typescript
// test/mock-llm-server.ts
import http from "node:http";

export function createMockLlmServer(cannedResponse: string) {
  return http.createServer((req, res) => {
    // Anthropic Messages API (Pi, Claude Code)
    if (req.method === "POST" && req.url?.includes("/messages")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.write(`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`);
      res.write(`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${cannedResponse}"}}\n\n`);
      res.write(`data: {"type":"content_block_stop","index":0}\n\n`);
      res.write(`data: {"type":"message_stop"}\n\n`);
      res.end();
    }
    // OpenAI Chat Completions API (OpenCode via Vercel AI SDK)
    else if (req.method === "POST" && req.url?.includes("/chat/completions")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      const id = "chatcmpl-mock";
      res.write(`data: {"id":"${id}","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"${cannedResponse}"},"finish_reason":null}]}\n\n`);
      res.write(`data: {"id":"${id}","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}
```

## Test plan

### Phase 1: Pi headless (`--print` mode)

**Location**: `packages/secure-exec/tests/cli-tools/pi-headless.test.ts`

**Setup**:
- Install `@mariozechner/pi-coding-agent` as devDependency
- Start mock LLM server on host
- Configure Pi to use mock server via environment variables
- Create sandbox with `allowAll` permissions

**Tests**:

| Test | What it verifies |
|------|-----------------|
| Pi boots in print mode | `pi --print "say hello"` exits with code 0 |
| Pi produces output | stdout contains the canned LLM response |
| Pi reads a file | Seed VFS with a file, `pi --print "read test.txt and summarize"` — Pi's read tool accesses the VFS file |
| Pi writes a file | `pi --print "create a file called out.txt with content hello"` — file exists in VFS after |
| Pi runs bash command | `pi --print "run ls /"` — Pi's bash tool executes `ls` via child_process |
| Pi JSON output mode | `pi --json "say hello"` — stdout is valid JSON with expected structure |
| Pi RPC mode boots | Start Pi in RPC mode, send a JSONL request on stdin, receive JSONL response |
| Pi session persistence | Run two sequential prompts with `--continue`, verify second sees first's context |

### Phase 2: Pi interactive (PTY mode)

**Location**: `packages/secure-exec/tests/cli-tools/pi-interactive.test.ts`

**Setup**:
- Same as Phase 1, plus `TerminalHarness` from terminal-e2e-testing spec
- Spawn Pi inside `openShell()` with PTY
- `process.stdout.isTTY` must be `true` in the sandbox (gap #5)

**Tests**:

| Test | What it verifies |
|------|-----------------|
| Pi TUI renders | Screen shows Pi's prompt/editor UI after boot |
| Input appears on screen | Type "hello" — text appears in editor area |
| Submit prompt renders response | Type prompt + Enter — LLM response renders on screen |
| `^C` interrupts | Send SIGINT during response streaming — Pi stays alive |
| Differential rendering works | Multiple interactions — screen updates without artifacts |
| Synchronized output | `CSI ?2026h`/`CSI ?2026l` sequences handled by xterm |
| Resize updates layout | Change PTY dimensions — Pi re-renders for new size |
| Exit cleanly | `/exit` or `^D` — Pi exits, PTY closes |

### Phase 3: OpenCode headless (`run` mode)

**Location**: `packages/secure-exec/tests/cli-tools/opencode-headless.test.ts`

**Setup**:
- Ensure `opencode` binary is installed and on host PATH (npm or brew)
- Start mock LLM server on host (OpenAI-compatible endpoint)
- Configure OpenCode to use mock server: write `opencode.json` config to VFS
  with provider `baseURL` pointing at mock server
- Set `OPENAI_API_KEY=test-key` in sandbox environment
- Create sandbox with `allowAll` permissions

**Two sub-strategies tested**:

#### Strategy A: Binary spawn via child_process

Spawn the `opencode` binary from inside the sandbox using `child_process.spawn`.
The binary runs on the host; the sandbox manages stdio and lifecycle.

| Test | What it verifies |
|------|-----------------|
| OpenCode boots in run mode | `opencode run "say hello"` exits with code 0 |
| OpenCode produces output | stdout contains the canned LLM response |
| OpenCode text format | `opencode run --format text "say hello"` — plain text output |
| OpenCode JSON format | `opencode run --format json "say hello"` — valid JSON response |
| OpenCode environment forwarding | API key and base URL reach the binary |
| OpenCode reads sandbox file | Seed VFS with a file, prompt asks to read it — file content in response |
| OpenCode writes sandbox file | Prompt asks to create a file — file exists in VFS after |
| OpenCode runs bash tool | Prompt triggers `echo hello` — bash tool executes on host |
| SIGINT stops execution | Send SIGINT during run — process terminates cleanly |
| Exit code on error | Bad API key → non-zero exit |

#### Strategy B: SDK client via `@opencode-ai/sdk`

Start `opencode serve` on the host, then run `@opencode-ai/sdk` client code
inside the sandbox to interact with it. This tests the HTTP/SSE client bridge.

| Test | What it verifies |
|------|-----------------|
| SDK client connects | Create client, call health/status endpoint |
| SDK sends prompt | Send a prompt via SDK, receive streamed response |
| SDK session management | Create session, send message, list messages |
| SSE streaming works | Response streams incrementally (not all-at-once) |
| SDK error handling | Invalid session ID → proper error response |

### Phase 4: OpenCode interactive (PTY mode)

**Location**: `packages/secure-exec/tests/cli-tools/opencode-interactive.test.ts`

**Setup**:
- Same as Phase 3, plus `TerminalHarness` from terminal-e2e-testing spec
- Spawn `opencode` binary inside `openShell()` with PTY
- `process.stdout.isTTY` must be `true` in the sandbox

**Tests**:

| Test | What it verifies |
|------|-----------------|
| OpenCode TUI renders | Screen shows OpenCode's OpenTUI interface after boot |
| Input area works | Type prompt text — appears in input area |
| Submit shows response | Enter prompt — streaming response renders on screen |
| Tool approval renders | Prompt requiring bash tool — approval UI appears |
| Syntax highlighting works | Code blocks in response render with colors |
| `^C` interrupts | Send SIGINT during streaming — OpenCode stays alive |
| Resize reflows | Change PTY dimensions — TUI re-renders layout |
| Session persists | Second prompt in same session sees prior context |
| Exit cleanly | `:q` or `^C` — OpenCode exits, PTY closes |

### Phase 5: Claude Code headless (`-p` mode)

**Location**: `packages/secure-exec/tests/cli-tools/claude-headless.test.ts`

**Setup**:
- Install `@anthropic-ai/claude-code` as devDependency
- Start mock LLM server (Anthropic Messages API format)
- Set `ANTHROPIC_API_KEY=test-key`, `ANTHROPIC_BASE_URL=http://localhost:PORT`
- Create sandbox with `allowAll` permissions

**Tests**:

| Test | What it verifies |
|------|-----------------|
| Claude boots in headless mode | `claude -p "say hello"` exits with code 0 |
| Claude produces text output | stdout contains canned LLM response |
| Claude JSON output | `claude -p "say hello" --output-format json` — valid JSON with `result` field |
| Claude stream-json output | `claude -p "say hello" --output-format stream-json` — valid NDJSON stream |
| Claude reads a file | Seed VFS, ask Claude to read it — Read tool accesses file |
| Claude writes a file | Ask Claude to create a file — file exists in VFS after |
| Claude runs bash | Ask Claude to run `echo hello` — Bash tool works |
| Claude continues session | Two prompts with `--continue` — second sees first's context |
| Claude with allowed tools | `--allowedTools "Read,Bash"` — tools execute without prompts |
| Claude exit codes | Bad API key → non-zero exit, good prompt → exit 0 |

### Phase 6: Claude Code interactive (PTY mode)

**Location**: `packages/secure-exec/tests/cli-tools/claude-interactive.test.ts`

**Setup**:
- Same as Phase 5, plus `TerminalHarness`
- Spawn Claude inside `openShell()` with PTY
- `process.stdout.isTTY` must be `true` in the sandbox

**Tests**:

| Test | What it verifies |
|------|-----------------|
| Claude TUI renders | Screen shows Claude's Ink-based UI after boot |
| Input area works | Type prompt text — appears in input area |
| Submit shows response | Enter prompt — streaming response renders on screen |
| Tool approval UI | Prompt requiring tool — approval prompt appears on screen |
| `^C` interrupts response | Send SIGINT during streaming — Claude stays alive |
| Color output renders | ANSI color codes render correctly in xterm buffer |
| Resize reflows | Change PTY dimensions — Ink re-renders layout |
| `/help` command | Type `/help` — help text renders on screen |
| Exit cleanly | `/exit` or `^C` twice — Claude exits |

## Implementation phases

### Phase 0: Bridge gaps (prerequisites)

Before any CLI tool tests can run, close these gaps:

1. **Controllable `isTTY`** — When a sandbox process is spawned with a PTY
   slave as stdio, `process.stdout.isTTY` and `process.stdin.isTTY` must
   return `true`. Add a `tty` option to `ExecOptions` or detect PTY
   automatically from the FD table.

2. **`setRawMode()` under PTY** — When `isTTY` is true, `process.stdin
   .setRawMode(true)` must configure the PTY line discipline: disable
   canonical mode, disable echo. `setRawMode(false)` restores defaults.

3. **HTTPS client verification** — Run the existing Express/Fastify fixtures
   but with HTTPS (self-signed cert) to verify TLS works end-to-end through
   the bridge.

4. **Stream Transform/PassThrough** — Verify that `stream.Transform` and
   `stream.PassThrough` work correctly for SSE parsing patterns.

### Phase 1: Pi headless tests

1. Add `@mariozechner/pi-coding-agent` as devDependency to
   `packages/secure-exec`.
2. Create mock LLM server utility in test helpers.
3. Create `tests/cli-tools/pi-headless.test.ts`.
4. Run Pi in print mode inside sandbox with mock API.
5. Verify all headless tests pass.

### Phase 2: Pi interactive tests

1. Import `TerminalHarness` (from kernel test utils or shared).
2. Implement `isTTY` detection for PTY-attached processes (gap #5).
3. Implement `setRawMode()` bridging to PTY line discipline (gap #6).
4. Create `tests/cli-tools/pi-interactive.test.ts`.
5. Verify Pi TUI renders correctly through headless xterm.

### Phase 3: OpenCode headless tests (binary spawn)

1. Verify `opencode` binary is installed on the test host (skip tests if not).
2. Extend mock LLM server with OpenAI chat completions SSE format.
3. Create `opencode.json` config fixture with mock server base URL.
4. Create `tests/cli-tools/opencode-headless.test.ts` — Strategy A (binary
   spawn via child_process).
5. Add `@opencode-ai/sdk` as devDependency for Strategy B tests.
6. Start `opencode serve` as a background fixture; create Strategy B tests
   using SDK client inside the sandbox.
7. Verify signal forwarding and exit code propagation.

### Phase 4: OpenCode interactive tests (PTY)

1. Create `tests/cli-tools/opencode-interactive.test.ts`.
2. Spawn `opencode` binary from `openShell()` with PTY.
3. Verify OpenTUI renders correctly through headless xterm.
4. Test tool approval, streaming, and exit flows.

### Phase 5: Claude Code headless tests

1. Add `@anthropic-ai/claude-code` as devDependency.
2. Extend mock LLM server for Anthropic Messages API SSE format.
3. Create `tests/cli-tools/claude-headless.test.ts`.
4. Handle any npm package quirks (missing `sdk.mjs`, native binary).
5. Verify all headless tests pass.

### Phase 6: Claude Code interactive tests

1. Create `tests/cli-tools/claude-interactive.test.ts`.
2. Verify Ink TUI renders through headless xterm.
3. Test tool approval UI, streaming, and exit flows.

## Risks and mitigations

### Pi dependency tree size

Pi pulls in `pi-ai`, `pi-agent-core`, and `pi-tui`. These may import Node.js
APIs that the bridge doesn't support. **Mitigation**: Run Pi's import phase
first and log every bridge call to identify missing APIs before writing tests.

### Claude Code native binary

The npm package bundles or downloads a native binary in some versions. This
will not work in the sandbox. **Mitigation**: Use the SDK entry point
(`sdk.mjs`) directly, or use `@anthropic-ai/claude-agent-sdk` which is a
pure JS/TS package without native binary dependency.

### Network mocking complexity

Both tools have complex SSE/streaming protocols. The mock server must produce
protocol-correct responses or the tools will error on parse. **Mitigation**:
Record real API responses during manual testing and replay them.

### Module resolution for large dependency trees

Both tools have significant `node_modules` trees. The secure-exec module
resolution (node_modules overlay + ESM/CJS detection) may hit edge cases
with deeply nested dependencies. **Mitigation**: Test module loading first
with a minimal import of each tool before running full test suites.

### `isTTY` bridge change affects existing tests

Setting `isTTY = true` for PTY-attached processes changes behavior for any
code that checks it. **Mitigation**: Only set `isTTY = true` when the sandbox
process actually has a PTY slave FD, not globally. Existing non-PTY tests
are unaffected.

### Claude Code spawn stalling

Known issue (anthropics/claude-code#771): spawning Claude Code from Node.js
`child_process` can stall. This may affect the sandbox's bridge which routes
spawn through the kernel. **Mitigation**: Test with Agent SDK
(`@anthropic-ai/claude-agent-sdk`) as an alternative entry point that avoids
the CLI binary spawn path.

### OpenCode is a Bun binary, not Node.js

OpenCode cannot run inside the isolate VM — it is a compiled Bun executable.
Tests must spawn it as an external process or communicate via HTTP/SDK.
**Mitigation**: This is by design. The binary spawn path tests a different
(and equally important) aspect of the sandbox: host process management. The
SDK path tests HTTP client fidelity.

### OpenCode binary availability in CI

The `opencode` binary must be installed on the CI runner. It is not a simple
npm devDependency — it requires platform-specific binaries. **Mitigation**:
Gate OpenCode tests behind `skipUnless(hasOpenCodeBinary())`. Install via
`npm i -g opencode-ai` in CI setup, or `npx opencode-ai` for one-shot
execution.

### OpenCode SQLite dependency

OpenCode uses `bun:sqlite` for session persistence. This is embedded in the
Bun binary and not a concern for the sandbox (the binary runs on the host).
However, tests that verify session persistence need the SQLite database to be
accessible. **Mitigation**: Set `XDG_DATA_HOME` to a temp directory so
OpenCode stores its database in a predictable, test-isolated location.

### OpenCode server lifecycle

Strategy B (SDK client) requires `opencode serve` running as a background
process. If the server crashes or fails to start, SDK tests hang.
**Mitigation**: Start the server in `beforeAll`, verify it's healthy with
a GET to the root endpoint, kill it in `afterAll`. Use a unique port per
test run to avoid conflicts.

### OpenCode TUI rendering differences

OpenCode uses OpenTUI (TypeScript + Zig bindings) which may render differently
from standard terminal applications. ANSI escape sequences may include
non-standard or rarely-used codes. **Mitigation**: Use `waitFor()` with
content-based assertions rather than exact full-screen matches for OpenCode
interactive tests. Tighten assertions after empirically capturing the actual
rendering output.

## Test file layout

```
packages/secure-exec/tests/
├── cli-tools/
│   ├── mock-llm-server.ts           # Shared mock LLM API server (Anthropic + OpenAI formats)
│   ├── pi-headless.test.ts          # Phase 1: Pi print/JSON/RPC mode
│   ├── pi-interactive.test.ts       # Phase 2: Pi TUI through PTY
│   ├── opencode-headless.test.ts    # Phase 3: OpenCode run + SDK client
│   ├── opencode-interactive.test.ts # Phase 4: OpenCode TUI through PTY
│   ├── claude-headless.test.ts      # Phase 5: Claude -p mode
│   └── claude-interactive.test.ts   # Phase 6: Claude TUI through PTY
```

## Success criteria

- Pi boots and produces LLM-backed output in headless mode inside the sandbox
- Pi's TUI renders correctly through PTY + headless xterm
- Claude Code boots and produces output in `-p` mode inside the sandbox
- Claude Code's Ink TUI renders correctly through PTY + headless xterm
- OpenCode `run` command completes via child_process spawn from the sandbox
- OpenCode SDK client inside the sandbox communicates with `opencode serve`
- OpenCode's OpenTUI renders correctly through PTY + headless xterm
- All tests run in CI without real API keys (mock LLM server)
- No new bridge gaps left unfixed (isTTY, setRawMode, HTTPS, streams, SSE)
