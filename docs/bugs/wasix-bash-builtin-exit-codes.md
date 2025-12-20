# WASIX Bash Builtin Exit Code Bug

## Summary

When using `bash -c "command"` in WASIX, all **builtin commands** return exit code 45 (ENOEXEC) instead of their actual exit code. External commands work correctly.

## Affected

- Package: `sharrattj/bash` (wasmer registry)
- Affects: `bash -c` and `sh -c` with any builtin command
- Does NOT affect: External commands via PATH or absolute path

## Symptoms

```bash
# Builtins - ALL return exit code 45
bash -c "echo hello"      # stdout: hello, exit: 45 ✗
bash -c "true"            # exit: 45 ✗
bash -c "false"           # exit: 45 ✗
bash -c "exit 0"          # exit: 45 ✗
bash -c "exit 42"         # exit: 45 ✗
bash -c "pwd"             # stdout: /, exit: 45 ✗
bash -c "printf 'hi\n'"   # stdout: hi, exit: 45 ✗

# External commands - work correctly
bash -c "/bin/echo hello" # stdout: hello, exit: 0 ✓
bash -c "/bin/true"       # exit: 0 ✓
bash -c "/bin/false"      # exit: 1 ✓
bash -c "ls /"            # stdout: bin..., exit: 0 ✓
```

## Exit Code 45 Meaning

In WASIX errno definitions, 45 = `ENOEXEC` ("Executable file format error").

See: https://wasmerio.github.io/wasmer/crates/doc/wasmer_wasix_types/wasi/bindings/enum.Errno.html

## Root Cause (Hypothesis)

Likely related to the WASIX libc `posix_spawn` PATH issue. WASIX libc's posix_spawn doesn't search PATH - commands must be resolved to absolute paths first. See `wasix-runtime/src/main.rs` where we use the `which` crate to work around this.

When bash runs `-c "echo hello"`:
1. Bash may try to look up `echo` as an external command first via posix_spawn
2. posix_spawn fails with ENOEXEC (45) because it can't find `echo` without PATH resolution
3. Bash falls back to the builtin `echo` and executes it correctly (stdout works)
4. But bash incorrectly propagates the ENOEXEC (45) from step 2 as the final exit code

This explains why:
- External commands with absolute paths work (no PATH lookup needed)
- `ls /` works (likely found in /bin via some lookup)
- All builtins fail with 45 (ENOEXEC from the failed external command lookup)

The fix would likely be in wasix-org/bash to either:
1. Not attempt external command lookup for known builtins
2. Not propagate posix_spawn errors when falling back to builtins
3. Ensure PATH is properly set/searched before attempting posix_spawn

Note: Interactive bash (via stdin) works correctly - exit codes are proper. This suggests the `-c` flag code path has a different command resolution order.

## Impact on nanosandbox

- `child_process.exec()` uses `spawn("bash", ["-c", command])` internally
- This means exec() always reports an error (code 45) even on successful commands
- The stdout/stderr are still correct
- Workaround: Use `spawn()` with external commands directly

## Workarounds

1. **Use spawn() with direct commands** (not bash -c):
   ```js
   spawn('echo', ['hello'])  // Works, exit code 0
   spawn('ls', ['/'])        // Works, exit code 0
   ```

2. **Use absolute paths in bash -c**:
   ```js
   spawn('bash', ['-c', '/bin/echo hello'])  // Works, exit code 0
   ```

3. **Accept incorrect exit codes** for exec() and only check stdout/stderr

## Test Files

- `tests/debug-builtins.test.ts` - Demonstrates the issue
- `tests/debug-path2.test.ts` - Shows absolute path workaround

## Status

- **Open** - Waiting for fix in `sharrattj/bash` package
- Consider filing issue at wasmer registry or bash package repo
