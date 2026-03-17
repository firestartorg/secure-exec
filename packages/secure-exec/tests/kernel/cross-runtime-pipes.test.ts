/**
 * Cross-runtime pipe tests.
 *
 * Tests kernel pipe infrastructure: FD allocation, pipe read/write,
 * SpawnOptions FD overrides, cross-driver data flow, and EOF propagation.
 *
 * Integration tests with real WasmVM+Node are skipped when WASM binary
 * is not built.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createKernel } from '../../../kernel/src/index.ts';
import type {
  Kernel,
  KernelInterface,
  RuntimeDriver,
  DriverProcess,
  ProcessContext,
  ManagedProcess,
} from '../../../kernel/src/index.ts';
import { FILETYPE_PIPE } from '../../../kernel/src/types.ts';
import { TestFileSystem } from '../../../kernel/test/helpers.ts';
import {
  createIntegrationKernel,
  skipUnlessWasmBuilt,
  skipUnlessPyodide,
} from './helpers.ts';

// ---------------------------------------------------------------------------
// FD-aware MockRuntimeDriver — writes stdout/stderr via kernel FDs
// ---------------------------------------------------------------------------

interface FDMockCommandConfig {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** Read stdin via kernel fdRead and echo it to stdout via fdWrite. */
  echoStdin?: boolean;
}

/**
 * Mock runtime driver that performs I/O through kernel FD operations.
 * When stdout is a pipe, kernel.fdWrite routes data to PipeManager.
 */
class FDMockRuntimeDriver implements RuntimeDriver {
  name: string;
  commands: string[];
  kernelInterface: KernelInterface | null = null;
  private configs: Map<string, FDMockCommandConfig>;

  constructor(name: string, commandList: string[], configs?: Record<string, FDMockCommandConfig>) {
    this.name = name;
    this.commands = commandList;
    this.configs = new Map(Object.entries(configs ?? {}));
  }

  async init(kernel: KernelInterface): Promise<void> {
    this.kernelInterface = kernel;
  }

  spawn(command: string, args: string[], ctx: ProcessContext): DriverProcess {
    const config = this.configs.get(command) ?? {};
    const ki = this.kernelInterface!;
    const exitCode = config.exitCode ?? 0;

    let exitResolve!: (code: number) => void;
    const exitPromise = new Promise<number>((r) => { exitResolve = r; });

    const proc: DriverProcess = {
      writeStdin(_data) {},
      closeStdin() {},
      kill(_signal) { exitResolve(128 + _signal); },
      wait() { return exitPromise; },
      onStdout: null,
      onStderr: null,
      onExit: null,
    };

    // Execute I/O asynchronously
    (async () => {
      try {
        // Write stdout through kernel FD 1
        if (config.stdout) {
          const data = new TextEncoder().encode(config.stdout);
          ki.fdWrite(ctx.pid, 1, data);
        }

        // Write stderr through kernel FD 2
        if (config.stderr) {
          const data = new TextEncoder().encode(config.stderr);
          ki.fdWrite(ctx.pid, 2, data);
        }

        // Echo stdin to stdout (for cat-like behavior)
        if (config.echoStdin) {
          const data = await ki.fdRead(ctx.pid, 0, 65536);
          if (data.length > 0) {
            ki.fdWrite(ctx.pid, 1, data);
          }
        }

        // Close piped FDs to propagate EOF
        ki.fdClose(ctx.pid, 1);
        ki.fdClose(ctx.pid, 2);
      } catch {
        // Ignore FD errors (e.g., EBADF for default /dev/stdout)
      }
      exitResolve(exitCode);
      proc.onExit?.(exitCode);
    })();

    return proc;
  }

  async dispose(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Kernel-level pipe tests (MockRuntimeDriver, no WASM needed)
// ---------------------------------------------------------------------------

describe('kernel pipe infrastructure', () => {
  let kernel: Kernel;

  afterEach(async () => {
    await kernel?.dispose();
  });

  it('pipe() allocates read and write FDs in process FD table', async () => {
    const driver = new FDMockRuntimeDriver('mock', ['x'], { x: { exitCode: 0 } });
    const vfs = new TestFileSystem();
    kernel = createKernel({ filesystem: vfs });
    await kernel.mount(driver);

    const proc = kernel.spawn('x', []);
    const ki = driver.kernelInterface!;
    const { readFd, writeFd } = ki.pipe(proc.pid);

    // Both FDs are valid (>= 3, since 0-2 are stdio)
    expect(readFd).toBeGreaterThanOrEqual(3);
    expect(writeFd).toBeGreaterThanOrEqual(3);
    expect(readFd).not.toBe(writeFd);

    // Both should be pipe type
    expect(ki.fdStat(proc.pid, readFd).filetype).toBe(FILETYPE_PIPE);
    expect(ki.fdStat(proc.pid, writeFd).filetype).toBe(FILETYPE_PIPE);

    await proc.wait();
  });

  it('fdRead returns data written to pipe via fdWrite', async () => {
    const driver = new FDMockRuntimeDriver('mock', ['x'], { x: { exitCode: 0 } });
    const vfs = new TestFileSystem();
    kernel = createKernel({ filesystem: vfs });
    await kernel.mount(driver);

    const proc = kernel.spawn('x', []);
    const ki = driver.kernelInterface!;
    const { readFd, writeFd } = ki.pipe(proc.pid);

    // Write to pipe
    const written = ki.fdWrite(proc.pid, writeFd, new TextEncoder().encode('hello'));
    expect(written).toBe(5);

    // Read from pipe
    const data = await ki.fdRead(proc.pid, readFd, 1024);
    expect(new TextDecoder().decode(data)).toBe('hello');

    await proc.wait();
  });

  it('pipe EOF: closing write end causes reader to get empty data', async () => {
    const driver = new FDMockRuntimeDriver('mock', ['x'], { x: { exitCode: 0 } });
    const vfs = new TestFileSystem();
    kernel = createKernel({ filesystem: vfs });
    await kernel.mount(driver);

    const proc = kernel.spawn('x', []);
    const ki = driver.kernelInterface!;
    const { readFd, writeFd } = ki.pipe(proc.pid);

    // Write then close write end
    ki.fdWrite(proc.pid, writeFd, new TextEncoder().encode('data'));
    ki.fdClose(proc.pid, writeFd);

    // First read gets buffered data
    const data = await ki.fdRead(proc.pid, readFd, 1024);
    expect(new TextDecoder().decode(data)).toBe('data');

    // Second read gets EOF (empty)
    const eof = await ki.fdRead(proc.pid, readFd, 1024);
    expect(eof.length).toBe(0);

    await proc.wait();
  });

  it('spawn with stdoutFd routes output through pipe', async () => {
    // "echoer" writes "hello pipe" to FD 1. When FD 1 is a pipe, data flows through PipeManager.
    const echoer = new FDMockRuntimeDriver('echoer', ['echo-fd'], {
      'echo-fd': { stdout: 'hello pipe\n' },
    });
    // "shell" provides the process context for creating pipes
    const shell = new FDMockRuntimeDriver('shell', ['sh'], { sh: { exitCode: 0 } });
    const vfs = new TestFileSystem();
    kernel = createKernel({ filesystem: vfs });
    await kernel.mount(shell);
    await kernel.mount(echoer);

    // Spawn shell process (parent) that creates the pipe
    const shellProc = kernel.spawn('sh', []);
    const ki = shell.kernelInterface!;

    // Create pipe in shell's FD table
    const { readFd, writeFd } = ki.pipe(shellProc.pid);

    // Spawn echo-fd with stdout=writeFd (pipe write end)
    const echoProcManaged = ki.spawn('echo-fd', [], {
      ppid: shellProc.pid,
      stdoutFd: writeFd,
    });

    // Wait for echo to finish (it writes to pipe and exits)
    await echoProcManaged.wait();

    // Read from pipe read end in shell's FD table
    const data = await ki.fdRead(shellProc.pid, readFd, 1024);
    expect(new TextDecoder().decode(data)).toBe('hello pipe\n');

    await shellProc.wait();
  });

  it('spawn with stdinFd routes pipe data to stdin', async () => {
    // "cat-fd" reads from FD 0 and echoes to FD 1
    const catDriver = new FDMockRuntimeDriver('cat-rt', ['cat-fd'], {
      'cat-fd': { echoStdin: true },
    });
    const shell = new FDMockRuntimeDriver('shell', ['sh'], { sh: { exitCode: 0 } });
    const vfs = new TestFileSystem();
    kernel = createKernel({ filesystem: vfs });
    await kernel.mount(shell);
    await kernel.mount(catDriver);

    const shellProc = kernel.spawn('sh', []);
    const ki = shell.kernelInterface!;

    // Create two pipes: input pipe and output pipe
    const inputPipe = ki.pipe(shellProc.pid);
    const outputPipe = ki.pipe(shellProc.pid);

    // Write data to the input pipe
    ki.fdWrite(shellProc.pid, inputPipe.writeFd, new TextEncoder().encode('piped input'));
    ki.fdClose(shellProc.pid, inputPipe.writeFd);

    // Spawn cat-fd: stdin=inputPipe.readFd, stdout=outputPipe.writeFd
    const catProc = ki.spawn('cat-fd', [], {
      ppid: shellProc.pid,
      stdinFd: inputPipe.readFd,
      stdoutFd: outputPipe.writeFd,
    });

    await catProc.wait();

    // Read output from output pipe
    const data = await ki.fdRead(shellProc.pid, outputPipe.readFd, 1024);
    expect(new TextDecoder().decode(data)).toBe('piped input');

    await shellProc.wait();
  });

  it('cross-driver pipe: driver A stdout → pipe → driver B stdin', async () => {
    // Two different drivers connected via pipe
    const writerDriver = new FDMockRuntimeDriver('writer', ['write-cmd'], {
      'write-cmd': { stdout: 'cross-driver data\n' },
    });
    const readerDriver = new FDMockRuntimeDriver('reader', ['read-cmd'], {
      'read-cmd': { echoStdin: true },
    });
    const shell = new FDMockRuntimeDriver('shell', ['sh'], { sh: { exitCode: 0 } });
    const vfs = new TestFileSystem();
    kernel = createKernel({ filesystem: vfs });
    await kernel.mount(shell);
    await kernel.mount(writerDriver);
    await kernel.mount(readerDriver);

    const shellProc = kernel.spawn('sh', []);
    const ki = shell.kernelInterface!;

    // Create inter-process pipe and output capture pipe
    const interPipe = ki.pipe(shellProc.pid);
    const outputPipe = ki.pipe(shellProc.pid);

    // Spawn writer: stdout → interPipe.writeFd
    const writer = ki.spawn('write-cmd', [], {
      ppid: shellProc.pid,
      stdoutFd: interPipe.writeFd,
    });

    // Spawn reader: stdin ← interPipe.readFd, stdout → outputPipe.writeFd
    const reader = ki.spawn('read-cmd', [], {
      ppid: shellProc.pid,
      stdinFd: interPipe.readFd,
      stdoutFd: outputPipe.writeFd,
    });

    await writer.wait();
    await reader.wait();

    // Data should flow: writer → interPipe → reader → outputPipe
    const data = await ki.fdRead(shellProc.pid, outputPipe.readFd, 1024);
    expect(new TextDecoder().decode(data)).toBe('cross-driver data\n');

    await shellProc.wait();
  });

  it('piped stdout does not appear in exec() stdout', async () => {
    // When a child's stdout is piped, exec() should NOT capture that data
    // (it flows through the pipe, not the callback)
    const echoer = new FDMockRuntimeDriver('echoer', ['echo-fd'], {
      'echo-fd': { stdout: 'piped only\n' },
    });
    const shell = new FDMockRuntimeDriver('shell', ['sh'], { sh: { exitCode: 0 } });
    const vfs = new TestFileSystem();
    kernel = createKernel({ filesystem: vfs });
    await kernel.mount(shell);
    await kernel.mount(echoer);

    const shellProc = kernel.spawn('sh', []);
    const ki = shell.kernelInterface!;
    const pipe = ki.pipe(shellProc.pid);

    const captured: Uint8Array[] = [];
    const echoProc = ki.spawn('echo-fd', [], {
      ppid: shellProc.pid,
      stdoutFd: pipe.writeFd,
      onStdout: (data: Uint8Array) => captured.push(data),
    });

    await echoProc.wait();

    // onStdout callback should NOT receive piped data
    expect(captured.length).toBe(0);

    // But pipe should have the data
    const data = await ki.fdRead(shellProc.pid, pipe.readFd, 1024);
    expect(new TextDecoder().decode(data)).toBe('piped only\n');

    await shellProc.wait();
  });

  // -----------------------------------------------------------------------
  // Exploit/abuse path tests
  // -----------------------------------------------------------------------

  it('fdRead on invalid pipe FD throws EBADF', async () => {
    const driver = new FDMockRuntimeDriver('mock', ['x'], { x: { exitCode: 0 } });
    const vfs = new TestFileSystem();
    kernel = createKernel({ filesystem: vfs });
    await kernel.mount(driver);

    const proc = kernel.spawn('x', []);
    const ki = driver.kernelInterface!;

    await expect(ki.fdRead(proc.pid, 999, 10)).rejects.toThrow('EBADF');
    await proc.wait();
  });

  it('fdWrite to pipe read end throws EBADF', async () => {
    const driver = new FDMockRuntimeDriver('mock', ['x'], { x: { exitCode: 0 } });
    const vfs = new TestFileSystem();
    kernel = createKernel({ filesystem: vfs });
    await kernel.mount(driver);

    const proc = kernel.spawn('x', []);
    const ki = driver.kernelInterface!;
    const { readFd } = ki.pipe(proc.pid);

    expect(() => ki.fdWrite(proc.pid, readFd, new TextEncoder().encode('x'))).toThrow();
    await proc.wait();
  });
});

// ---------------------------------------------------------------------------
// Integration tests with real WasmVM + Node (skipped if WASM not built)
// ---------------------------------------------------------------------------

describe.skipIf(skipUnlessWasmBuilt())('cross-runtime pipes (WasmVM + Node)', () => {
  let kernel: Kernel;
  let dispose: () => Promise<void>;

  afterEach(async () => {
    await dispose?.();
  });

  it('WasmVM echo | cat pipe works', async () => {
    ({ kernel, dispose } = await createIntegrationKernel({ runtimes: ['wasmvm'] }));
    const result = await kernel.exec('echo hello | cat', { timeout: 15000 });
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  }, 30000);

  it('WasmVM echo | node -e pipe works', async () => {
    ({ kernel, dispose } = await createIntegrationKernel({ runtimes: ['wasmvm', 'node'] }));
    const script = 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(d.toUpperCase()))';
    const result = await kernel.exec(`echo hello | node -e '${script}'`, { timeout: 15000 });
    expect(result.stdout.trim()).toBe('HELLO');
    expect(result.exitCode).toBe(0);
  }, 30000);

  it('WasmVM echo | WasmVM wc -c pipe works', async () => {
    ({ kernel, dispose } = await createIntegrationKernel({ runtimes: ['wasmvm'] }));
    const result = await kernel.exec('echo hello | wc -c', { timeout: 15000 });
    // "hello\n" is 6 bytes
    expect(result.stdout.trim()).toBe('6');
    expect(result.exitCode).toBe(0);
  }, 30000);
});

describe.skipIf(skipUnlessWasmBuilt() || skipUnlessPyodide())('cross-runtime pipes (WasmVM + Python)', () => {
  let kernel: Kernel;
  let dispose: () => Promise<void>;

  afterEach(async () => {
    await dispose?.();
  });

  it('WasmVM cat | python -c pipe works', async () => {
    ({ kernel, dispose } = await createIntegrationKernel({ runtimes: ['wasmvm', 'python'] }));
    await kernel.writeFile('/tmp/input.txt', 'test data\n');
    const script = 'import sys; print(sys.stdin.read().upper(), end="")';
    const result = await kernel.exec(`cat /tmp/input.txt | python -c '${script}'`, { timeout: 20000 });
    expect(result.stdout.trim()).toBe('TEST DATA');
    expect(result.exitCode).toBe(0);
  }, 30000);
});
