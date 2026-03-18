# Spec: Terminal E2E Testing with Headless xterm

## Status

Draft

## Motivation

The interactive shell (`kernel.openShell()` / `kernel.connectTerminal()`) has
integration tests that assert on raw byte streams — substring checks on PTY
output that ignore escape sequences, cursor movement, and screen layout. This
means:

- Tests can't verify what the user actually sees. A command could produce
  correct bytes but render incorrectly (wrong line, overwritten output,
  missing newline).
- PTY line discipline behavior (echo, canonical buffering, signal chars) is
  only partially tested — current tests check that bytes pass through, not
  that the screen state is correct after a sequence of interactions.
- WasmVM shell commands (`ls`, `echo`, `cat`) have no terminal-level tests
  at all. The existing `driver.test.ts` tests use `kernel.exec()` (non-interactive),
  so brush-shell interactive behavior is untested.
- Cross-runtime spawning from the shell (e.g. `node -e "..."` from brush-shell)
  has no output verification.

The goal is exact-match testing of the full terminal screen after each
interaction, so that any rendering regression is caught.

## Approach

### Headless terminal emulator

Use `@xterm/headless` — the headless build of xterm.js — as a virtual terminal
in tests. It parses escape sequences and maintains a screen buffer identical
to what a real terminal UI would show. No DOM, no browser, runs in Node/vitest.

Data flow:

```
shell.write(input)
    │
    ▼
PTY master → line discipline → PTY slave → shell process (WasmVM/mock)
    │                                           │
    │◄──────────── shell output ◄───────────────┘
    │
    ▼
shell.onData(bytes) → term.write(bytes) → xterm screen buffer
    │
    ▼
screenshotTrimmed() → deterministic string for assertions
```

### Test helper: `TerminalHarness`

A small class that wires `openShell()` to an `@xterm/headless` Terminal:

```typescript
class TerminalHarness {
  readonly term: Terminal;
  readonly shell: ShellHandle;

  /** Send input through the PTY. Resolves after data settles. */
  async type(input: string): Promise<void>;

  /**
   * Full screen as a string: every row from the xterm buffer, trailing
   * whitespace trimmed per line, trailing empty lines dropped, joined
   * with '\n'. This is the canonical representation for assertions.
   */
  screenshotTrimmed(): string;

  /** Single row from the screen buffer (0-indexed), trimmed. */
  line(row: number): string;

  /**
   * Wait until screenshotTrimmed() contains `text`. Polls the screen
   * buffer; throws after timeoutMs. Use `occurrence` to wait for the
   * Nth match (e.g. wait for the 2nd prompt after a command completes).
   */
  async waitFor(text: string, occurrence?: number, timeoutMs?: number): Promise<void>;

  /** Send ^D on empty line and await shell exit. Returns exit code. */
  async exit(): Promise<number>;

  /** Kill shell and dispose terminal. */
  async dispose(): Promise<void>;
}
```

### Assertion style

Every output assertion MUST be an exact match on the full screen state.
No `toContain()`, no substring checks. The test specifies exactly what
every visible line should be:

```typescript
expect(h.screenshotTrimmed()).toBe([
  '$ echo hello',
  'hello',
  '$ ',
].join('\n'));
```

This ensures that:
- The typed command appears (PTY echo)
- The output is on the correct line
- The prompt returns after the command
- No extra/missing lines exist
- Previous output is preserved across commands

When exact matching is impractical (e.g. timestamps, PIDs), individual lines
can be matched with `line(row)` + regex, but this should be the exception.

## Test locations

Two test files, testing different layers:

### `packages/kernel/test/shell-terminal.test.ts`

Tests the PTY and terminal plumbing using `MockRuntimeDriver`. No WASM binary
required. These tests verify the kernel's line discipline, echo, signal
handling, and screen rendering work correctly.

| Test | What it verifies |
|------|-----------------|
| Clean initial state | Shell opens, screen is empty or shows prompt |
| Echo on input | Typed text appears on screen via PTY echo |
| Command output on correct line | Mock echo-back appears below the input line |
| Output preservation | Multiple commands — all previous output stays visible |
| `^C` sends SIGINT | Screen shows `^C`, shell stays alive, can type more |
| `^D` exits cleanly | Shell exits with code 0, no extra output |
| Backspace erases character | `helo` + BS + `lo\n` → screen shows `hello` |
| Long line wrapping | Input exceeding cols wraps to next row |

### `packages/runtime/wasmvm/test/shell-terminal.test.ts`

Tests real WasmVM shell commands through the terminal. Requires the WASM
binary (guarded with `skipIf(!hasWasmBinary)`). These tests verify that
brush-shell and the WasmVM command dispatch produce correct interactive output.

| Test | What it verifies |
|------|-----------------|
| `echo` prints output | `echo hello` → "hello" on next line, prompt returns |
| `ls /` shows listing | Directory entries rendered correctly |
| Output preserved across commands | `echo AAA` then `echo BBB` — both visible |
| `cat` reads VFS file | Write file to VFS, `cat` it, content appears |
| Pipe works | `echo foo \| cat` → "foo" |
| Exit code on bad command | `nonexistent` → error message on screen |
| `node -e` cross-runtime | `node -e "console.log(42)"` → "42" on screen |
| `python3 -c` cross-runtime | `python3 -c "print(99)"` → "99" on screen |

## Dependency

Add `@xterm/headless` as a devDependency to both `packages/kernel` and
`packages/runtime/wasmvm`. It is a pure JavaScript package with no native
addons or DOM dependency.

```
pnpm -F @secure-exec/kernel add -D @xterm/headless
pnpm -F @anthropic-ai/wasmvm add -D @xterm/headless
```

## Implementation phases

### Phase 1: Kernel terminal tests (mock driver)

1. Add `@xterm/headless` devDependency to `packages/kernel`.
2. Create `TerminalHarness` utility in `packages/kernel/test/terminal-harness.ts`.
3. Create `packages/kernel/test/shell-terminal.test.ts` with mock driver tests.
4. Verify all tests pass with `pnpm vitest run` in `packages/kernel`.

### Phase 2: WasmVM terminal tests (real shell)

1. Add `@xterm/headless` devDependency to `packages/runtime/wasmvm`.
2. Import or duplicate `TerminalHarness` in `packages/runtime/wasmvm/test/`.
3. Create `packages/runtime/wasmvm/test/shell-terminal.test.ts` with real
   command tests (gated behind `hasWasmBinary`).
4. Verify tests pass with the WASM binary built.

### Phase 3: Cross-runtime tests

1. Add Node and Python runtime mounting in the WasmVM terminal tests.
2. Test `node -e` and `python3 -c` output appears correctly on screen.
3. These tests require all three runtimes mounted into the same kernel.

## Risks and open questions

### Prompt format

brush-shell's interactive prompt format (`$ `, `bash-5.2$ `, or something
else) needs to be captured empirically. Tests will break if the prompt
changes. Mitigation: define the expected prompt as a constant at the top
of the test file.

### Timing

`waitFor()` polls the screen buffer. Commands that take a long time (e.g.
Python startup via Pyodide) need generous timeouts. Keep default timeout
low (2s) for fast commands, allow per-call override.

### Cross-runtime stdout routing

`node` and `python3` spawned from brush-shell route through `proc_spawn` →
kernel → runtime driver → back through PTY. This path has known issues
(stdout may not flow back through the PTY slave). If cross-runtime tests
fail, the fix is in the spawn/stdio wiring, not the test infrastructure.

### Terminal dimensions

Tests should use a fixed size (e.g. 80x24) so line wrapping is deterministic.
The harness constructor should enforce this.
