import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NodeFileSystem,
  NodeProcess,
  createNodeDriver,
} from "../../../../packages/sandboxed-node/src/index.ts";
import {
  LOOPBACK_HOST,
  findOpenPort,
  prepareRunnerInTempDir,
  waitForServer,
} from "../../../shared/src/sandbox-runner-utils.ts";

async function main(): Promise<void> {
  const loaderDir = path.dirname(fileURLToPath(import.meta.url));
  const runnerSourceRoot = path.resolve(loaderDir, "../../runner");

  const { tempDir: runnerRoot, entryPath: runnerEntry } =
    await prepareRunnerInTempDir(runnerSourceRoot);

  try {
    const runnerCode = await readFile(runnerEntry, "utf8");
    const runnerPort = await findOpenPort();
    const baseUrl = `http://${LOOPBACK_HOST}:${runnerPort}`;

    const driver = createNodeDriver({
      filesystem: new NodeFileSystem(),
      useDefaultNetwork: true,
    });

    const proc = new NodeProcess({
      driver,
      processConfig: {
        cwd: runnerRoot,
        argv: ["node", runnerEntry],
      },
    });

    const execPromise = proc.exec(runnerCode, {
      filePath: runnerEntry,
      cwd: runnerRoot,
      env: {
        HONO_PORT: String(runnerPort),
        HONO_HOST: LOOPBACK_HOST,
      },
    });

    await waitForServer(proc, baseUrl);

    const textResponse = await proc.network.fetch(`${baseUrl}/`, { method: "GET" });
    const jsonResponse = await proc.network.fetch(`${baseUrl}/json`, { method: "GET" });

    console.log(`loader:text:${textResponse.status}:${textResponse.body}`);
    console.log(`loader:json:${jsonResponse.status}:${jsonResponse.body}`);

    // Shut down the sandbox from the host side.
    await proc.terminate();

    // Ensure pending execution settles after termination.
    await execPromise.catch(() => undefined);
  } finally {
    await rm(runnerRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
