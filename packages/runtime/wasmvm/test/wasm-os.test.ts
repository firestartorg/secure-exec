/**
 * Tests for WasmOS public API.
 *
 * With the brush-shell migration (US-005), all shell parsing/evaluation
 * is handled by brush-shell inside WASM. The host simply spawns
 * `sh -c '<command>'` via the pipeline orchestrator.
 *
 * Uses a mock pipeline to test the orchestration logic without a real WASM module.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { WasmOS } from '../src/wasm-os.ts';
import WasmOSDefault from '../src/wasm-os.ts';
import { VFS } from '../src/vfs.ts';
import { PipelineOrchestrator } from '../src/pipeline.ts';
import type { PipelineStage, PipelineResult } from '../src/pipeline.ts';

/** Helper type to access private WasmOS fields in tests. */
interface WasmOSInternals {
  _pipeline: PipelineOrchestrator & {
    executePipeline: (
      stages: PipelineStage[],
      env?: Record<string, string>,
      cwd?: string,
      vfs?: VFS | null,
      stdin?: Uint8Array,
    ) => Promise<PipelineResult>;
  };
  _env: Record<string, string>;
}

// --- index.js re-export tests ---

describe('index.js exports', () => {
  it('re-exports WasmOS as named export', async () => {
    const mod = await import('../src/index.js');
    assert.strictEqual(mod.WasmOS, WasmOS);
  });

  it('re-exports WasmOS as default export', async () => {
    const mod = await import('../src/index.js');
    assert.strictEqual(mod.default, WasmOS);
  });
});

// --- Constructor tests ---

describe('WasmOS constructor', () => {
  it('creates instance with default options', () => {
    const os = new WasmOS();
    assert.ok(os instanceof WasmOS);
  });

  it('creates instance with all options', () => {
    const os = new WasmOS({
      wasmBinary: new Uint8Array(0),
      env: { FOO: 'bar' },
      fs: { '/tmp/test.txt': 'hello' },
      cwd: '/home/user',
    });
    assert.ok(os instanceof WasmOS);
  });

  it('has default export equal to named export', () => {
    assert.strictEqual(WasmOSDefault, WasmOS);
  });
});

// --- Pre-init guard tests ---

describe('WasmOS pre-init guards', () => {
  it('exec() throws before init', async () => {
    const os = new WasmOS();
    await assert.rejects(() => os.exec('echo hello'), /not initialized/i);
  });

  it('writeFile() throws before init', () => {
    const os = new WasmOS();
    assert.throws(() => os.writeFile('/tmp/f', 'data'), /not initialized/i);
  });

  it('readFile() throws before init', () => {
    const os = new WasmOS();
    assert.throws(() => os.readFile('/tmp/f'), /not initialized/i);
  });

  it('mkdir() throws before init', () => {
    const os = new WasmOS();
    assert.throws(() => os.mkdir('/tmp/dir'), /not initialized/i);
  });
});

// --- Init tests ---

describe('WasmOS init', () => {
  it('initializes without wasmBinary (no compilation)', async () => {
    const os = new WasmOS();
    // init without wasmBinary should still work (for testing/mocking scenarios)
    // We need to provide a workerScript so the pipeline doesn't fail on exec,
    // but init itself should succeed
    await os.init();
    // Calling init again is a no-op
    await os.init();
  });

  it('populates initial files from fs option (string content)', async () => {
    const os = new WasmOS({
      fs: { '/tmp/hello.txt': 'hello world' },
    });
    await os.init();
    assert.strictEqual(os.readFile('/tmp/hello.txt'), 'hello world');
  });

  it('populates initial files from fs option (Uint8Array content)', async () => {
    const data = new TextEncoder().encode('binary content');
    const os = new WasmOS({
      fs: { '/tmp/data.bin': data },
    });
    await os.init();
    assert.strictEqual(os.readFile('/tmp/data.bin'), 'binary content');
  });

  it('creates parent directories for initial files', async () => {
    const os = new WasmOS({
      fs: { '/a/b/c/file.txt': 'nested' },
    });
    await os.init();
    assert.strictEqual(os.readFile('/a/b/c/file.txt'), 'nested');
  });

  it('sets default environment variables', async () => {
    const os = new WasmOS();
    await os.init();
    // Access internal env to verify defaults
    assert.strictEqual((os as unknown as WasmOSInternals)._env.PATH, '/bin');
    assert.strictEqual((os as unknown as WasmOSInternals)._env.HOME, '/home/user');
    assert.strictEqual((os as unknown as WasmOSInternals)._env.USER, 'user');
  });

  it('merges user env with defaults', async () => {
    const os = new WasmOS({ env: { CUSTOM: 'value', PATH: '/usr/bin' } });
    await os.init();
    assert.strictEqual((os as unknown as WasmOSInternals)._env.CUSTOM, 'value');
    assert.strictEqual((os as unknown as WasmOSInternals)._env.PATH, '/usr/bin');
    assert.strictEqual((os as unknown as WasmOSInternals)._env.HOME, '/home/user');
  });
});

// --- VFS access tests ---

describe('WasmOS VFS access', () => {
  let os: WasmOS;

  beforeEach(async () => {
    os = new WasmOS();
    await os.init();
  });

  it('writeFile and readFile with string content', () => {
    os.writeFile('/tmp/test.txt', 'hello');
    assert.strictEqual(os.readFile('/tmp/test.txt'), 'hello');
  });

  it('writeFile and readFile with Uint8Array content', () => {
    const data = new Uint8Array([0x48, 0x69]); // "Hi"
    os.writeFile('/tmp/binary.bin', data);
    assert.strictEqual(os.readFile('/tmp/binary.bin'), 'Hi');
  });

  it('mkdir creates directory', () => {
    os.mkdir('/tmp/mydir');
    // Writing inside should work
    os.writeFile('/tmp/mydir/file.txt', 'content');
    assert.strictEqual(os.readFile('/tmp/mydir/file.txt'), 'content');
  });

  it('mkdir creates nested directories', () => {
    os.mkdir('/tmp/a/b/c');
    os.writeFile('/tmp/a/b/c/deep.txt', 'deep');
    assert.strictEqual(os.readFile('/tmp/a/b/c/deep.txt'), 'deep');
  });

  it('readFile throws for non-existent file', () => {
    assert.throws(() => os.readFile('/nonexistent'));
  });

  it('VFS has default directories', () => {
    // These should exist from VFS constructor
    os.writeFile('/tmp/exists.txt', 'yes');
    assert.strictEqual(os.readFile('/tmp/exists.txt'), 'yes');
  });
});

// --- exec tests with mock pipeline ---

describe('WasmOS exec (mock pipeline)', () => {
  it('passes command to sh -c via pipeline', async () => {
    const os = new WasmOS();
    await os.init();

    // Replace the pipeline with a mock
    (os as unknown as WasmOSInternals)._pipeline.executePipeline = async (stages, env, cwd, vfs, stdin) => {
      // Should always be a single stage: sh -c '<command>'
      assert.strictEqual(stages.length, 1);
      assert.strictEqual(stages[0].command, 'sh');
      assert.deepStrictEqual(stages[0].args, ['-c', 'echo hello']);
      return {
        exitCode: 0,
        stdout: new TextEncoder().encode('hello\n'),
        stderr: new Uint8Array(0),
        vfsSnapshot: [],
      };
    };

    const result = await os.exec('echo hello');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'hello\n');
    assert.strictEqual(result.stderr, '');
  });

  it('returns decoded strings in exec result', async () => {
    const os = new WasmOS();
    await os.init();

    (os as unknown as WasmOSInternals)._pipeline.executePipeline = async () => ({
      exitCode: 1,
      stdout: new TextEncoder().encode('out'),
      stderr: new TextEncoder().encode('err msg'),
      vfsSnapshot: [],
    });

    const result = await os.exec('failing-cmd');
    assert.strictEqual(typeof result.stdout, 'string');
    assert.strictEqual(typeof result.stderr, 'string');
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.stdout, 'out');
    assert.strictEqual(result.stderr, 'err msg');
  });

  it('passes pipeline commands as single sh -c stage', async () => {
    const os = new WasmOS();
    await os.init();

    (os as unknown as WasmOSInternals)._pipeline.executePipeline = async (stages) => {
      // Pipeline commands are passed as a single string to brush-shell
      assert.strictEqual(stages.length, 1);
      assert.strictEqual(stages[0].command, 'sh');
      assert.deepStrictEqual(stages[0].args, ['-c', 'echo hello | cat | wc -c']);
      return {
        exitCode: 0,
        stdout: new TextEncoder().encode('6\n'),
        stderr: new Uint8Array(0),
        vfsSnapshot: [],
      };
    };

    const result = await os.exec('echo hello | cat | wc -c');
    assert.strictEqual(result.stdout, '6\n');
  });

  it('passes && chaining as single sh -c stage', async () => {
    const os = new WasmOS();
    await os.init();

    (os as unknown as WasmOSInternals)._pipeline.executePipeline = async (stages) => {
      assert.strictEqual(stages.length, 1);
      assert.strictEqual(stages[0].command, 'sh');
      assert.deepStrictEqual(stages[0].args, ['-c', 'echo a && echo b']);
      return {
        exitCode: 0,
        stdout: new TextEncoder().encode('a\nb\n'),
        stderr: new Uint8Array(0),
        vfsSnapshot: [],
      };
    };

    const result = await os.exec('echo a && echo b');
    assert.strictEqual(result.stdout, 'a\nb\n');
  });

  it('passes environment to pipeline', async () => {
    const os = new WasmOS();
    await os.init();

    (os as unknown as WasmOSInternals)._pipeline.executePipeline = async (stages, env) => {
      assert.strictEqual(env!.HOME, '/home/user');
      assert.strictEqual(env!.PATH, '/bin');
      return {
        exitCode: 0,
        stdout: new Uint8Array(0),
        stderr: new Uint8Array(0),
        vfsSnapshot: [],
      };
    };

    await os.exec('echo $HOME');
  });

  it('merges VFS changes from shell worker', async () => {
    const os = new WasmOS();
    await os.init();

    (os as unknown as WasmOSInternals)._pipeline.executePipeline = async () => ({
      exitCode: 0,
      stdout: new Uint8Array(0),
      stderr: new Uint8Array(0),
      vfsSnapshot: [
        { type: 'file', path: '/tmp/out.txt', data: new TextEncoder().encode('file content\n') },
      ],
    });

    await os.exec('echo file content > /tmp/out.txt');
    assert.strictEqual(os.readFile('/tmp/out.txt'), 'file content\n');
  });

  it('handles ; list commands as single sh -c stage', async () => {
    const os = new WasmOS();
    await os.init();

    (os as unknown as WasmOSInternals)._pipeline.executePipeline = async (stages) => {
      assert.strictEqual(stages.length, 1);
      assert.strictEqual(stages[0].command, 'sh');
      assert.deepStrictEqual(stages[0].args, ['-c', 'echo a; echo b']);
      return {
        exitCode: 0,
        stdout: new TextEncoder().encode('a\nb\n'),
        stderr: new Uint8Array(0),
        vfsSnapshot: [],
      };
    };

    const result = await os.exec('echo a; echo b');
    assert.strictEqual(result.stdout, 'a\nb\n');
  });
});
