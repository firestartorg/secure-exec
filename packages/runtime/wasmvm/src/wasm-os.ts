/**
 * WasmOS — top-level orchestrator that ties together the WASI polyfill,
 * VFS, and pipeline orchestrator into a clean public API.
 *
 * Shell parsing and evaluation are handled entirely by brush-shell inside
 * the WASM binary. The host simply spawns `sh -c '<command>'` via the
 * pipeline orchestrator.
 *
 * Usage:
 *   const os = new WasmOS({ wasmBinary });
 *   await os.init();
 *   const { stdout, stderr, exitCode } = await os.exec('echo hello | wc -c');
 */

import { VFS } from './vfs.ts';
import { PipelineOrchestrator } from './pipeline.ts';

/**
 * Resolve the path to worker-entry.js relative to this module.
 * Works in both Node.js and browser contexts.
 */
function defaultWorkerScript(): URL {
  return new URL('./worker-entry.ts', import.meta.url);
}

export interface WasmOSOptions {
  wasmBinary?: BufferSource;
  env?: Record<string, string>;
  fs?: Record<string, string | Uint8Array>;
  cwd?: string;
  workerScript?: string | URL;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class WasmOS {
  private _wasmBinary: BufferSource | null;
  private _env: Record<string, string>;
  private _initialFiles: Record<string, string | Uint8Array>;
  private _cwd: string;
  private _workerScript: string | URL | null;
  private _vfs: VFS | null = null;
  private _pipeline: PipelineOrchestrator | null = null;
  private _compiledModule: WebAssembly.Module | null = null;
  private _initialized = false;

  constructor(options: WasmOSOptions = {}) {
    this._wasmBinary = options.wasmBinary || null;
    this._env = { PATH: '/bin', HOME: '/home/user', USER: 'user', ...(options.env || {}) };
    this._initialFiles = options.fs || {};
    this._cwd = options.cwd || '/';
    this._workerScript = options.workerScript || null;
  }

  /**
   * Compile the WASM module, initialize VFS, and set up the pipeline.
   * Must be called before exec().
   */
  async init(): Promise<void> {
    if (this._initialized) return;

    // Initialize VFS with default layout
    this._vfs = new VFS();

    // Populate initial files
    for (const [path, content] of Object.entries(this._initialFiles)) {
      // Ensure parent directories exist
      const dir = path.substring(0, path.lastIndexOf('/')) || '/';
      if (dir !== '/' && !this._vfs.exists(dir)) {
        this._vfs.mkdirp(dir);
      }
      if (typeof content === 'string') {
        this._vfs.writeFile(path, new TextEncoder().encode(content));
      } else {
        this._vfs.writeFile(path, content);
      }
    }

    // Resolve worker script
    const workerScript = this._workerScript || defaultWorkerScript();

    // Set up pipeline orchestrator
    this._pipeline = new PipelineOrchestrator({ workerScript });

    // Compile WASM module if binary was provided
    if (this._wasmBinary) {
      this._compiledModule = await this._pipeline.compileModule(this._wasmBinary);
    }

    this._initialized = true;
  }

  /**
   * Execute a shell command string via brush-shell.
   *
   * The command is passed to brush-shell as `sh -c '<command>'`, which
   * handles all parsing, variable expansion, pipelines, redirects,
   * control flow, and process spawning internally.
   */
  async exec(command: string): Promise<ExecResult> {
    this._assertInitialized();

    const result = await this._pipeline!.executePipeline(
      [{ command: 'sh', args: ['-c', command] }],
      this._env,
      this._cwd,
      this._vfs,
    );

    // Merge VFS changes back from the shell worker
    if (result.vfsSnapshot && this._vfs) {
      for (const entry of result.vfsSnapshot) {
        if (entry.type === 'file' && entry.data) {
          const dir = entry.path.substring(0, entry.path.lastIndexOf('/')) || '/';
          if (dir !== '/' && !this._vfs.exists(dir)) {
            this._vfs.mkdirp(dir);
          }
          this._vfs.writeFile(entry.path, entry.data);
        } else if (entry.type === 'dir' || entry.type === 'directory') {
          if (!this._vfs.exists(entry.path)) {
            this._vfs.mkdirp(entry.path);
          }
        }
      }
    }

    const decoder = new TextDecoder();
    return {
      exitCode: result.exitCode,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
    };
  }

  /**
   * Write a file to the VFS.
   */
  writeFile(path: string, content: string | Uint8Array): void {
    this._assertInitialized();
    if (typeof content === 'string') {
      this._vfs!.writeFile(path, new TextEncoder().encode(content));
    } else {
      this._vfs!.writeFile(path, content);
    }
  }

  /**
   * Read a file from the VFS.
   */
  readFile(path: string): string {
    this._assertInitialized();
    const data = this._vfs!.readFile(path);
    return new TextDecoder().decode(data);
  }

  /**
   * Create a directory in the VFS (creates parent directories as needed).
   */
  mkdir(path: string): void {
    this._assertInitialized();
    this._vfs!.mkdirp(path);
  }

  private _assertInitialized(): void {
    if (!this._initialized) {
      throw new Error('WasmOS not initialized. Call init() first.');
    }
  }
}

export default WasmOS;
