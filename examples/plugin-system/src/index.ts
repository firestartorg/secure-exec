import {
  NodeRuntime,
  allowAllFs,
  createInMemoryFileSystem,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "secure-exec";

const filesystem = createInMemoryFileSystem();
await filesystem.mkdir("/plugins");
await filesystem.writeFile(
  "/plugins/title-case.js",
  `
    module.exports = {
      manifest: {
        name: "title-case",
        version: "1.0.0",
      },
      transform(input, options = {}) {
        const words = String(input)
          .split(/\\s+/)
          .filter(Boolean)
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());

        return (options.prefix ?? "") + words.join(" ");
      },
    };
  `
);

const runtime = new NodeRuntime({
  systemDriver: createNodeDriver({
    filesystem,
    permissions: { ...allowAllFs },
  }),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
  memoryLimit: 64,
  cpuTimeLimitMs: 1000,
});

const input = "hello from plugin land";
const options = { prefix: "Plugin says: " };

const result = await runtime.run<{
  manifest: { name: string; version: string };
  output: string;
}>(`
  const plugin = require("/plugins/title-case.js");

  module.exports = {
    manifest: plugin.manifest,
    output: plugin.transform(
      ${JSON.stringify(input)},
      ${JSON.stringify(options)}
    ),
  };
`, "/root/run-plugin.js");

console.log(result.exports?.manifest.name); // "title-case"
console.log(result.exports?.output); // "Plugin says: Hello From Plugin Land"
