import {
	NodeRuntime,
	createInMemoryFileSystem,
	createNodeDriver,
	createNodeRuntimeDriverFactory,
} from "../../../packages/secure-exec/src/index.ts";

const filesystem = createInMemoryFileSystem();
await filesystem.writeFile("/secret.txt", "top secret");
const runtime = new NodeRuntime({
	systemDriver: createNodeDriver({
		filesystem,
		permissions: {
			fs: (request) => ({ allow: request.path.startsWith("/workspace") }),
		},
	}),
	runtimeDriverFactory: createNodeRuntimeDriverFactory(),
});

const result = await runtime.run<{
	message: string;
	blocked: boolean;
}>(
	`
  const fs = require("node:fs");

  fs.mkdirSync("/workspace", { recursive: true });
  fs.writeFileSync("/workspace/message.txt", "hello from permissions");

  let blocked = false;
  try {
    fs.readFileSync("/secret.txt", "utf8");
  } catch (error) {
    blocked = error && error.code === "EACCES";
  }

  module.exports = {
    message: fs.readFileSync("/workspace/message.txt", "utf8"),
    blocked,
  };
`,
);

console.log(
	JSON.stringify({
		ok:
			result.code === 0 &&
			result.exports?.message === "hello from permissions" &&
			result.exports?.blocked === true,
		message: result.exports?.message,
		blocked: result.exports?.blocked,
		summary: "filesystem access was allowed for /workspace and denied for /secret.txt",
	}),
);
