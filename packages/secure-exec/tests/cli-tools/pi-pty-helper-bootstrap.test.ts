/**
 * PTY bootstrap regression for Pi's helper-tool setup.
 *
 * Uses the real Pi CLI through kernel.openShell() without mock provider
 * redirects. The sandbox only exposes `tar`; Pi must rely on preseeded
 * upstream `fd` / `rg` binaries rather than the sandbox command surface.
 */

import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allowAllChildProcess,
  allowAllEnv,
  allowAllFs,
  allowAllNetwork,
  createKernel,
} from '../../../core/src/index.ts';
import type { Kernel, ShellHandle } from '../../../core/src/index.ts';
import {
  createNodeHostNetworkAdapter,
  createNodeRuntime,
} from '../../../nodejs/src/index.ts';
import { createWasmVmRuntime } from '../../../wasmvm/src/index.ts';
import {
  buildPiInteractiveCode,
  createHybridVfs,
  SECURE_EXEC_ROOT,
  seedPiManagedTools,
  skipUnlessPiInstalled,
  WASM_COMMANDS_DIR,
} from './pi-pty-helpers.ts';

function getSkipReason(): string | false {
  const piSkip = skipUnlessPiInstalled();
  if (piSkip) return piSkip;

  if (!existsSync(path.join(WASM_COMMANDS_DIR, 'tar'))) {
    return 'WasmVM tar command not built (expected native/wasmvm/.../commands/tar)';
  }

  return false;
}

async function waitForBootstrap(
  shell: ShellHandle,
  getOutput: () => string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const output = getOutput();
    const visibleOutput = output
      .replace(/\u001b\][^\u0007]*\u0007/g, '')
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '');
    if (
      output.includes('\u001b[?2004h') &&
      visibleOutput.includes('drop files to attach')
    ) {
      return;
    }

    const exitCode = await Promise.race([
      shell.wait(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);
    if (exitCode !== null) {
      throw new Error(
        `Pi exited before bootstrap completed (code ${exitCode}).\nRaw PTY:\n${output}`,
      );
    }
  }

  throw new Error(
    `Pi helper bootstrap timed out after ${timeoutMs}ms.\nRaw PTY:\n${getOutput()}`,
  );
}

const skipReason = getSkipReason();

describe.skipIf(skipReason)('Pi PTY helper bootstrap (sandbox)', () => {
  let kernel: Kernel | undefined;
  let shell: ShellHandle | undefined;
  let workDir: string | undefined;
  let tarRuntimeDir: string | undefined;

  afterEach(async () => {
    try {
      shell?.kill();
    } catch {
      // Shell may have already exited.
    }
    shell = undefined;
    await kernel?.dispose();
    kernel = undefined;
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = undefined;
    }
    if (tarRuntimeDir) {
      await rm(tarRuntimeDir, { recursive: true, force: true });
      tarRuntimeDir = undefined;
    }
  });

  it('reaches the Pi TUI with tar-only sandbox commands and preseeded upstream helpers', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'pi-pty-helper-bootstrap-'));
    tarRuntimeDir = await mkdtemp(path.join(tmpdir(), 'pi-pty-tar-runtime-'));
    const helperBinDir = await seedPiManagedTools(workDir);
    await copyFile(path.join(WASM_COMMANDS_DIR, 'tar'), path.join(tarRuntimeDir, 'tar'));
    await chmod(path.join(tarRuntimeDir, 'tar'), 0o755);

    const permissions = {
      ...allowAllFs,
      ...allowAllNetwork,
      ...allowAllChildProcess,
      ...allowAllEnv,
    };

    kernel = createKernel({
      filesystem: createHybridVfs(workDir),
      hostNetworkAdapter: createNodeHostNetworkAdapter(),
      permissions,
    });
    await kernel.mount(
      createNodeRuntime({
        permissions,
      }),
    );
    await kernel.mount(createWasmVmRuntime({ commandDirs: [tarRuntimeDir] }));

    shell = kernel.openShell({
      command: 'node',
      args: ['-e', buildPiInteractiveCode({ workDir, providerApiKey: 'test-key' })],
      cwd: SECURE_EXEC_ROOT,
      env: {
        HOME: workDir,
        NO_COLOR: '1',
        ANTHROPIC_API_KEY: 'test-key',
        PATH: `${helperBinDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      },
    });

    const decoder = new TextDecoder();
    let rawOutput = '';
    shell.onData = (data) => {
      rawOutput += decoder.decode(data);
    };

    await waitForBootstrap(shell, () => rawOutput, 30_000);

    const visibleOutput = rawOutput
      .replace(/\u001b\][^\u0007]*\u0007/g, '')
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '');

    expect(visibleOutput).not.toContain('ENOENT: command not found: tar');
    expect(visibleOutput).not.toContain('fd 0.1.0 (secure-exec)');
    expect(visibleOutput).not.toContain("rg: unrecognized option '--version'");

    shell.kill();
    const exitCode = await Promise.race([
      shell.wait(),
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('Pi did not terminate after bootstrap probe')), 20_000),
      ),
    ]);

    expect(exitCode).not.toBeNull();
  }, 60_000);
});
