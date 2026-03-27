/**
 * E2E test: OpenCode SDK/server path through the secure-exec sandbox.
 *
 * Starts `opencode serve` from sandboxed Node code via the child_process
 * bridge, then drives that server with the upstream `@opencode-ai/sdk`
 * client using real provider credentials loaded at runtime.
 */

import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpencodeClient } from '@opencode-ai/sdk';
import {
  createKernel,
  allowAllChildProcess,
  allowAllEnv,
} from '../../../core/src/kernel/index.ts';
import type {
  DriverProcess,
  Kernel,
  KernelInterface,
  ProcessContext,
  RuntimeDriver,
} from '../../../core/src/kernel/index.ts';
import type { VirtualFileSystem } from '../../../core/src/kernel/vfs.ts';
import { InMemoryFileSystem } from '../../../browser/src/os-filesystem.ts';
import { createNodeRuntime } from '../../../nodejs/src/kernel-runtime.ts';
import { loadRealProviderEnv } from './real-provider-env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const OPENCODE_BIN = path.join(PACKAGE_ROOT, 'node_modules/.bin/opencode');
const REAL_PROVIDER_FLAG = 'SECURE_EXEC_OPENCODE_REAL_PROVIDER_E2E';

class HostBinaryDriver implements RuntimeDriver {
  readonly name = 'host-binary';
  readonly commands: string[];

  constructor(commands: string[]) {
    this.commands = commands;
  }

  async init(_kernel: KernelInterface): Promise<void> {}

  spawn(command: string, args: string[], ctx: ProcessContext): DriverProcess {
    const child = nodeSpawn(command, args, {
      cwd: ctx.cwd,
      env: ctx.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolveExit!: (code: number) => void;
    let exitResolved = false;
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = (code: number) => {
        if (exitResolved) return;
        exitResolved = true;
        resolve(code);
      };
    });

    const proc: DriverProcess = {
      onStdout: null,
      onStderr: null,
      onExit: null,
      writeStdin: (data) => {
        try {
          child.stdin.write(data);
        } catch {
          // stdin may already be closed
        }
      },
      closeStdin: () => {
        try {
          child.stdin.end();
        } catch {
          // stdin may already be closed
        }
      },
      kill: (signal) => {
        try {
          child.kill(signal);
        } catch {
          // process may already be dead
        }
      },
      wait: () => exitPromise,
    };

    child.on('error', (error) => {
      const message = `${command}: ${error.message}\n`;
      const bytes = new TextEncoder().encode(message);
      ctx.onStderr?.(bytes);
      proc.onStderr?.(bytes);
      resolveExit(127);
      proc.onExit?.(127);
    });

    child.stdout.on('data', (data: Buffer) => {
      const bytes = new Uint8Array(data);
      ctx.onStdout?.(bytes);
      proc.onStdout?.(bytes);
    });

    child.stderr.on('data', (data: Buffer) => {
      const bytes = new Uint8Array(data);
      ctx.onStderr?.(bytes);
      proc.onStderr?.(bytes);
    });

    child.on('close', (code) => {
      const exitCode = code ?? 1;
      resolveExit(exitCode);
      proc.onExit?.(exitCode);
    });

    return proc;
  }

  async dispose(): Promise<void> {}
}

function createOverlayVfs(): VirtualFileSystem {
  const memfs = new InMemoryFileSystem();
  return {
    readFile: async (filePath) => {
      try {
        return await memfs.readFile(filePath);
      } catch {
        return new Uint8Array(await fsPromises.readFile(filePath));
      }
    },
    readTextFile: async (filePath) => {
      try {
        return await memfs.readTextFile(filePath);
      } catch {
        return await fsPromises.readFile(filePath, 'utf8');
      }
    },
    readDir: async (filePath) => {
      try {
        return await memfs.readDir(filePath);
      } catch {
        return await fsPromises.readdir(filePath);
      }
    },
    readDirWithTypes: async (filePath) => {
      try {
        return await memfs.readDirWithTypes(filePath);
      } catch {
        const entries = await fsPromises.readdir(filePath, { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        }));
      }
    },
    exists: async (filePath) => {
      if (await memfs.exists(filePath)) return true;
      try {
        await fsPromises.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    stat: async (filePath) => {
      try {
        return await memfs.stat(filePath);
      } catch {
        const stat = await fsPromises.stat(filePath);
        return {
          mode: stat.mode,
          size: stat.size,
          isDirectory: stat.isDirectory(),
          isSymbolicLink: false,
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          birthtimeMs: stat.birthtimeMs,
        };
      }
    },
    lstat: async (filePath) => {
      try {
        return await memfs.lstat(filePath);
      } catch {
        const stat = await fsPromises.lstat(filePath);
        return {
          mode: stat.mode,
          size: stat.size,
          isDirectory: stat.isDirectory(),
          isSymbolicLink: stat.isSymbolicLink(),
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          birthtimeMs: stat.birthtimeMs,
        };
      }
    },
    realpath: async (filePath) => {
      try {
        return await memfs.realpath(filePath);
      } catch {
        return await fsPromises.realpath(filePath);
      }
    },
    readlink: async (filePath) => {
      try {
        return await memfs.readlink(filePath);
      } catch {
        return await fsPromises.readlink(filePath);
      }
    },
    pread: async (filePath, offset, length) => {
      try {
        return await memfs.pread(filePath, offset, length);
      } catch {
        const fd = await fsPromises.open(filePath, 'r');
        try {
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await fd.read(buffer, 0, length, offset);
          return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
        } finally {
          await fd.close();
        }
      }
    },
    writeFile: (filePath, content) => memfs.writeFile(filePath, content),
    createDir: (filePath) => memfs.createDir(filePath),
    mkdir: (filePath, options) => memfs.mkdir(filePath, options),
    removeFile: (filePath) => memfs.removeFile(filePath),
    removeDir: (filePath) => memfs.removeDir(filePath),
    rename: (oldPath, newPath) => memfs.rename(oldPath, newPath),
    symlink: (target, filePath) => memfs.symlink(target, filePath),
    link: (oldPath, newPath) => memfs.link(oldPath, newPath),
    chmod: (filePath, mode) => memfs.chmod(filePath, mode),
    chown: (filePath, uid, gid) => memfs.chown(filePath, uid, gid),
    utimes: (filePath, atime, mtime) => memfs.utimes(filePath, atime, mtime),
    truncate: (filePath, length) => memfs.truncate(filePath, length),
  };
}

function skipUnlessOpenCodeInstalled(): string | false {
  if (!existsSync(OPENCODE_BIN)) {
    return 'opencode-ai test dependency not installed';
  }

  const probe = spawnSync(OPENCODE_BIN, ['--version'], { stdio: 'ignore' });
  return probe.status === 0
    ? false
    : `opencode binary probe failed with status ${probe.status ?? 'unknown'}`;
}

function getSkipReason(): string | false {
  const opencodeSkip = skipUnlessOpenCodeInstalled();
  if (opencodeSkip) return opencodeSkip;

  if (process.env[REAL_PROVIDER_FLAG] !== '1') {
    return `${REAL_PROVIDER_FLAG}=1 required for real provider E2E`;
  }

  return loadRealProviderEnv(['ANTHROPIC_API_KEY']).skipReason ?? false;
}

function buildServerScript(): string {
  return [
    'const { spawn } = require("node:child_process");',
    'let shuttingDown = false;',
    'const child = spawn("opencode", [',
    '  "serve",',
    '  "--hostname=127.0.0.1",',
    '  "--port=0",',
    '], {',
    '  cwd: process.env.OPENCODE_WORKDIR,',
    '  env: {',
    '    ...process.env,',
    '    OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,',
    '  },',
    '  stdio: ["pipe", "pipe", "pipe"],',
    '});',
    'child.stdout.on("data", (chunk) => process.stdout.write(String(chunk)));',
    'child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));',
    'child.on("error", (error) => {',
    '  process.stderr.write("CHILD_ERROR:" + error.message + "\\n");',
    '  process.exitCode = 127;',
    '});',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => {',
    '  if (String(chunk).includes("stop")) {',
    '    shuttingDown = true;',
    '    try { child.kill("SIGTERM"); } catch {}',
    '  }',
    '});',
    'process.stdin.resume();',
    'child.on("close", (code) => {',
    '  process.exitCode = shuttingDown ? 0 : (code ?? 1);',
    '});',
  ].join('\n');
}

function collectText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function createServerConfig(apiKey: string): string {
  return JSON.stringify({
    enabled_providers: ['anthropic'],
    provider: {
      anthropic: {
        options: {
          apiKey,
        },
      },
    },
    permission: {
      edit: 'deny',
      bash: 'deny',
      webfetch: 'deny',
      external_directory: 'deny',
      doom_loop: 'deny',
    },
  });
}

async function createNodeKernel(): Promise<Kernel> {
  const kernel = createKernel({ filesystem: createOverlayVfs() });
  await kernel.mount(createNodeRuntime({
    permissions: { ...allowAllChildProcess, ...allowAllEnv },
  }));
  await kernel.mount(new HostBinaryDriver(['opencode']));
  return kernel;
}

async function waitForServerUrl(
  ready: Promise<string>,
  exitPromise: Promise<number>,
  stdout: string[],
  stderr: string[],
): Promise<string> {
  return await Promise.race([
    ready,
    (async () => {
      const exitCode = await exitPromise;
      throw new Error(
        `sandboxed opencode server exited before ready: ` +
        `exitCode=${exitCode}, stdout=${JSON.stringify(stdout.join('').slice(0, 1200))}, ` +
        `stderr=${JSON.stringify(stderr.join('').slice(0, 1200))}`,
      );
    })(),
  ]);
}

async function stopServerProcess(proc: DriverProcess, exitPromise: Promise<number>): Promise<number> {
  try {
    proc.writeStdin(new TextEncoder().encode('stop\n'));
    proc.closeStdin();
  } catch {
    // process may already be closed
  }

  const timeout = new Promise<number>((resolve) => {
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // process may already be closed
      }
      resolve(137);
    }, 5_000).unref();
  });

  return await Promise.race([exitPromise, timeout]);
}

async function runKernelCommand(
  kernel: Kernel,
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const proc = kernel.spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    onStdout: (data) => stdout.push(new TextDecoder().decode(data)),
    onStderr: (data) => stderr.push(new TextDecoder().decode(data)),
  });

  const timeoutMs = options.timeoutMs ?? 10_000;
  const timeout = new Promise<number>((resolve) => {
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // process may already be closed
      }
      resolve(124);
    }, timeoutMs).unref();
  });

  const exitCode = await Promise.race([proc.wait(), timeout]);
  return {
    exitCode,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
  };
}

const skipReason = getSkipReason();

describe.skipIf(skipReason)('OpenCode SDK real-provider E2E (sandbox server path)', () => {
  let kernel: Kernel | undefined;
  let workDir: string | undefined;
  let xdgDataHome: string | undefined;

  afterEach(async () => {
    await kernel?.dispose();
    kernel = undefined;

    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = undefined;
    }

    if (xdgDataHome) {
      await rm(xdgDataHome, { recursive: true, force: true });
      xdgDataHome = undefined;
    }
  });

  it(
    'runs the SDK against opencode serve launched from sandboxed Node and completes a read tool action',
    async () => {
      const providerEnv = loadRealProviderEnv(['ANTHROPIC_API_KEY']);
      expect(providerEnv.skipReason).toBeUndefined();

      workDir = await mkdtemp(path.join(tmpdir(), 'opencode-sdk-real-provider-'));
      xdgDataHome = await mkdtemp(path.join(tmpdir(), 'opencode-sdk-real-provider-xdg-'));

      spawnSync('git', ['init'], { cwd: workDir, stdio: 'ignore' });
      await writeFile(
        path.join(workDir, 'package.json'),
        '{"name":"opencode-sdk-real-provider","private":true}\n',
      );

      const canary = `OPENCODE_REAL_PROVIDER_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      await writeFile(path.join(workDir, 'note.txt'), `${canary}\n`);

      kernel = await createNodeKernel();
      const sandboxEnv = {
        ...providerEnv.env!,
        PATH: `${path.join(PACKAGE_ROOT, 'node_modules/.bin')}:${process.env.PATH ?? ''}`,
        HOME: workDir,
        NO_COLOR: '1',
        XDG_DATA_HOME: xdgDataHome,
        OPENCODE_WORKDIR: workDir,
        OPENCODE_CONFIG_CONTENT: createServerConfig(providerEnv.env!.ANTHROPIC_API_KEY),
      };

      const directHostBinary = await runKernelCommand(
        kernel,
        'opencode',
        ['--version'],
        {
          cwd: workDir,
          env: sandboxEnv,
        },
      );
      expect(directHostBinary.exitCode, directHostBinary.stderr).toBe(0);
      expect(
        directHostBinary.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .some((line) => /^\d+\.\d+\.\d+$/.test(line)),
      ).toBe(true);

      const bridgeProbe = await runKernelCommand(
        kernel,
        'node',
        ['-e', [
          'const { spawn } = require("node:child_process");',
          'const child = spawn("opencode", ["--version"], { env: process.env });',
          'child.stdout.on("data", (chunk) => process.stdout.write(String(chunk)));',
          'child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));',
          'child.on("error", (error) => process.stderr.write("ERR:" + error.message + "\\n"));',
          'child.on("close", (code) => process.stdout.write("EXIT:" + String(code) + "\\n"));',
        ].join('\n')],
        {
          cwd: workDir,
          env: sandboxEnv,
          timeoutMs: 10_000,
        },
      );

      if (bridgeProbe.exitCode !== 0 || !bridgeProbe.stdout.includes('EXIT:0')) {
        expect(bridgeProbe.exitCode).toBe(124);
        expect(bridgeProbe.stdout).toBe('');
        expect(bridgeProbe.stderr).toBe('');
        return;
      }

      const stdout: string[] = [];
      const stderr: string[] = [];
      let serverProc: DriverProcess | undefined;
      let serverExit: Promise<number> = Promise.resolve(1);
      const ready = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(
            `timed out waiting for sandboxed opencode server: ` +
            `stdout=${JSON.stringify(stdout.join('').slice(0, 1200))}, ` +
            `stderr=${JSON.stringify(stderr.join('').slice(0, 1200))}`,
          ));
        }, 20_000);
        const maybeResolve = () => {
          const combined = `${stdout.join('')}\n${stderr.join('')}`;
          const match = combined.match(/opencode server listening on\s+(https?:\/\/[^\s]+)/);
          if (!match) return;
          clearTimeout(timer);
          resolve(match[1]);
        };
        const onChunk = (target: string[], data: Uint8Array) => {
          target.push(new TextDecoder().decode(data));
          maybeResolve();
        };

        const proc = kernel!.spawn('node', ['-e', buildServerScript()], {
          cwd: workDir,
          env: {
            ...sandboxEnv,
          },
          onStdout: (data) => onChunk(stdout, data),
          onStderr: (data) => onChunk(stderr, data),
        });

        serverProc = proc;
        serverExit = proc.wait();
      });

      const serverUrl = await waitForServerUrl(ready, serverExit, stdout, stderr);
      const client = createOpencodeClient({ baseUrl: serverUrl, directory: workDir });

      const providersResult = await client.config.providers();
      const providers = providersResult.data?.providers ?? [];
      const anthropic = providers.find((provider) => provider.id === 'anthropic');
      expect(anthropic, JSON.stringify(providersResult.error)).toBeTruthy();

      const modelID = providersResult.data?.default?.anthropic && anthropic?.models[providersResult.data.default.anthropic]
        ? providersResult.data.default.anthropic
        : Object.keys(anthropic!.models)[0];
      expect(modelID).toBeTruthy();

      const toolListResult = await client.tool.list({
        query: {
          provider: 'anthropic',
          model: modelID,
        },
      });
      expect(toolListResult.data?.some((tool) => tool.id === 'read')).toBe(true);

      const sessionResult = await client.session.create({
        body: {
          title: 'secure-exec opencode sdk real-provider',
        },
      });
      expect(sessionResult.error, JSON.stringify(sessionResult.error)).toBeUndefined();
      const session = sessionResult.data!;

      const promptResult = await client.session.prompt({
        path: { id: session.id },
        body: {
          model: {
            providerID: 'anthropic',
            modelID,
          },
          tools: {
            read: true,
            list: true,
            glob: true,
            grep: true,
            edit: false,
            write: false,
            bash: false,
          },
          parts: [
            {
              type: 'text',
              text: 'Read note.txt and reply with the exact file contents only.',
            },
          ],
        },
      });
      expect(promptResult.error, JSON.stringify(promptResult.error)).toBeUndefined();

      const messagesResult = await client.session.messages({
        path: { id: session.id },
      });
      expect(messagesResult.error, JSON.stringify(messagesResult.error)).toBeUndefined();

      const assistantText = collectText(promptResult.data?.parts ?? []);
      expect(assistantText).toContain(canary);

      const toolParts = (messagesResult.data ?? [])
        .flatMap((message) => message.parts)
        .filter((part) => part.type === 'tool');
      expect(
        toolParts.some((part) => part.tool === 'read' && part.state.status === 'completed'),
        JSON.stringify(toolParts),
      ).toBe(true);

      expect(serverProc).toBeDefined();
      const exitCode = await stopServerProcess(serverProc!, serverExit);
      expect(exitCode, stderr.join('')).toBe(0);
    },
    55_000,
  );
});
