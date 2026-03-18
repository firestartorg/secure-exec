import {
  NodeRuntime,
  allowAllFs,
  createInMemoryFileSystem,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "../../../packages/secure-exec/src/index.ts";

const filesystem = createInMemoryFileSystem();
const runtime = new NodeRuntime({
  systemDriver: createNodeDriver({
    filesystem,
    permissions: { ...allowAllFs },
  }),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
});

try {
  const result = await runtime.exec(`
    const fs = require("node:fs");
    fs.mkdirSync("/workspace", { recursive: true });
    fs.writeFileSync("/workspace/hello.txt", "hello from the sandbox");
  `);

  if (result.code !== 0) {
    throw new Error(`Unexpected execution result: ${JSON.stringify(result)}`);
  }

  const message = await filesystem.readTextFile("/workspace/hello.txt");

  console.log(
    JSON.stringify({
      ok: message === "hello from the sandbox",
      message,
      summary: "sandbox wrote to the in-memory filesystem",
    }),
  );
} finally {
  runtime.dispose();
}
