import { existsSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VirtualFileSystem } from '../../../core/src/index.ts';
import { InMemoryFileSystem } from '../../../browser/src/os-filesystem.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const WORKSPACE_ROOT = path.resolve(__dirname, '../../../..');
export const SECURE_EXEC_ROOT = path.resolve(__dirname, '../..');
export const WASM_COMMANDS_DIR = path.resolve(
  SECURE_EXEC_ROOT,
  '../../native/wasmvm/target/wasm32-wasip1/release/commands',
);
export const PI_TOOL_CACHE_DIR = path.join(tmpdir(), 'secure-exec-pi-tool-cache');
export const PI_TOOLS_MANAGER = path.resolve(
  SECURE_EXEC_ROOT,
  'node_modules/@mariozechner/pi-coding-agent/dist/utils/tools-manager.js',
);
export const PI_CLI = path.resolve(
  SECURE_EXEC_ROOT,
  'node_modules/@mariozechner/pi-coding-agent/dist/cli.js',
);

export const PI_BASE_FLAGS = [
  '--verbose',
  '--no-session',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
];

export function skipUnlessPiInstalled(): string | false {
  return existsSync(PI_CLI)
    ? false
    : '@mariozechner/pi-coding-agent not installed';
}

export function buildPiInteractiveCode(opts: {
  workDir: string;
  providerApiKey?: string;
}): string {
  const flags = [
    ...PI_BASE_FLAGS,
    '--provider',
    'anthropic',
    '--model',
    'claude-sonnet-4-20250514',
  ];

  const providerApiKeyLine = typeof opts.providerApiKey === 'string'
    ? `process.env.ANTHROPIC_API_KEY = ${JSON.stringify(opts.providerApiKey)};`
    : '';

  return `(async () => {
    try {
      process.chdir(${JSON.stringify(opts.workDir)});
      process.argv = ['node', 'pi', ${flags.map((flag) => JSON.stringify(flag)).join(', ')}];
      process.env.HOME = ${JSON.stringify(opts.workDir)};
      process.env.NO_COLOR = '1';
      process.env.PATH = ${JSON.stringify(path.join(opts.workDir, '.pi/agent/bin'))} + ':/usr/bin:/bin';
      ${providerApiKeyLine}
      await import(${JSON.stringify(PI_CLI)});
    } catch (error) {
      console.error(error && error.stack ? error.stack : String(error));
      process.exitCode = 1;
    }
  })()`;
}

export async function seedPiManagedTools(workDir: string): Promise<string> {
  const helperBinDir = path.join(workDir, '.pi/agent/bin');
  await mkdir(helperBinDir, { recursive: true });

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;

  try {
    process.env.PI_CODING_AGENT_DIR = path.join(PI_TOOL_CACHE_DIR, 'agent');
    process.env.HOME = PI_TOOL_CACHE_DIR;
    process.env.PATH = '/usr/bin:/bin';

    const { ensureTool } = await import(PI_TOOLS_MANAGER) as {
      ensureTool: (tool: 'fd' | 'rg', silent?: boolean) => Promise<string | undefined>;
    };

    const fdPath = await ensureTool('fd', true);
    const rgPath = await ensureTool('rg', true);
    if (!fdPath || !rgPath) {
      throw new Error('Failed to provision Pi managed fd/rg binaries');
    }

    await copyFile(fdPath, path.join(helperBinDir, 'fd'));
    await copyFile(rgPath, path.join(helperBinDir, 'rg'));
    await chmod(path.join(helperBinDir, 'fd'), 0o755);
    await chmod(path.join(helperBinDir, 'rg'), 0o755);
    return helperBinDir;
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

export function createHybridVfs(workDir: string): VirtualFileSystem {
  const memfs = new InMemoryFileSystem();
  const hostRoots = [WORKSPACE_ROOT, SECURE_EXEC_ROOT, workDir, '/tmp'];

  const isHostPath = (targetPath: string): boolean =>
    hostRoots.some((root) => targetPath === root || targetPath.startsWith(`${root}/`));

  return {
    readFile: async (targetPath) => {
      try { return await memfs.readFile(targetPath); }
      catch { return new Uint8Array(await fsPromises.readFile(targetPath)); }
    },
    readTextFile: async (targetPath) => {
      try { return await memfs.readTextFile(targetPath); }
      catch { return await fsPromises.readFile(targetPath, 'utf-8'); }
    },
    readDir: async (targetPath) => {
      try { return await memfs.readDir(targetPath); }
      catch { return await fsPromises.readdir(targetPath); }
    },
    readDirWithTypes: async (targetPath) => {
      try { return await memfs.readDirWithTypes(targetPath); }
      catch {
        const entries = await fsPromises.readdir(targetPath, { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        }));
      }
    },
    exists: async (targetPath) => {
      if (await memfs.exists(targetPath)) return true;
      try {
        await fsPromises.access(targetPath);
        return true;
      } catch {
        return false;
      }
    },
    stat: async (targetPath) => {
      try { return await memfs.stat(targetPath); }
      catch {
        const info = await fsPromises.stat(targetPath);
        return {
          mode: info.mode,
          size: info.size,
          isDirectory: info.isDirectory(),
          isSymbolicLink: false,
          atimeMs: info.atimeMs,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
          birthtimeMs: info.birthtimeMs,
          ino: info.ino,
          nlink: info.nlink,
          uid: info.uid,
          gid: info.gid,
        };
      }
    },
    lstat: async (targetPath) => {
      try { return await memfs.lstat(targetPath); }
      catch {
        const info = await fsPromises.lstat(targetPath);
        return {
          mode: info.mode,
          size: info.size,
          isDirectory: info.isDirectory(),
          isSymbolicLink: info.isSymbolicLink(),
          atimeMs: info.atimeMs,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
          birthtimeMs: info.birthtimeMs,
          ino: info.ino,
          nlink: info.nlink,
          uid: info.uid,
          gid: info.gid,
        };
      }
    },
    realpath: async (targetPath) => {
      try { return await memfs.realpath(targetPath); }
      catch { return await fsPromises.realpath(targetPath); }
    },
    readlink: async (targetPath) => {
      try { return await memfs.readlink(targetPath); }
      catch { return await fsPromises.readlink(targetPath); }
    },
    pread: async (targetPath, offset, length) => {
      try { return await memfs.pread(targetPath, offset, length); }
      catch {
        const fd = await fsPromises.open(targetPath, 'r');
        try {
          const buf = Buffer.alloc(length);
          const { bytesRead } = await fd.read(buf, 0, length, offset);
          return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
        } finally {
          await fd.close();
        }
      }
    },
    writeFile: (targetPath, content) =>
      isHostPath(targetPath)
        ? fsPromises.writeFile(targetPath, content)
        : memfs.writeFile(targetPath, content),
    createDir: (targetPath) =>
      isHostPath(targetPath)
        ? fsPromises.mkdir(targetPath)
        : memfs.createDir(targetPath),
    mkdir: (targetPath, options) =>
      isHostPath(targetPath)
        ? fsPromises.mkdir(targetPath, { recursive: options?.recursive ?? true })
        : memfs.mkdir(targetPath, options),
    removeFile: (targetPath) =>
      isHostPath(targetPath)
        ? fsPromises.unlink(targetPath)
        : memfs.removeFile(targetPath),
    removeDir: (targetPath) =>
      isHostPath(targetPath)
        ? fsPromises.rm(targetPath, { recursive: true, force: false })
        : memfs.removeDir(targetPath),
    rename: (oldPath, newPath) =>
      (isHostPath(oldPath) || isHostPath(newPath))
        ? fsPromises.rename(oldPath, newPath)
        : memfs.rename(oldPath, newPath),
    symlink: (target, linkPath) =>
      isHostPath(linkPath)
        ? fsPromises.symlink(target, linkPath)
        : memfs.symlink(target, linkPath),
    link: (oldPath, newPath) =>
      (isHostPath(oldPath) || isHostPath(newPath))
        ? fsPromises.link(oldPath, newPath)
        : memfs.link(oldPath, newPath),
    chmod: (targetPath, mode) =>
      isHostPath(targetPath)
        ? fsPromises.chmod(targetPath, mode)
        : memfs.chmod(targetPath, mode),
    chown: (targetPath, uid, gid) =>
      isHostPath(targetPath)
        ? fsPromises.chown(targetPath, uid, gid)
        : memfs.chown(targetPath, uid, gid),
    utimes: (targetPath, atime, mtime) =>
      isHostPath(targetPath)
        ? fsPromises.utimes(targetPath, atime, mtime)
        : memfs.utimes(targetPath, atime, mtime),
    truncate: (targetPath, length) =>
      isHostPath(targetPath)
        ? fsPromises.truncate(targetPath, length)
        : memfs.truncate(targetPath, length),
  };
}
