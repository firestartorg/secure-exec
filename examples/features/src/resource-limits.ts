import {
  NodeRuntime,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "../../../packages/secure-exec/src/index.ts";

const runtime = new NodeRuntime({
  systemDriver: createNodeDriver(),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
  memoryLimit: 64,
  cpuTimeLimitMs: 100,
});

try {
  const safeRun = await runtime.exec(`
    console.log("resource-limits-ok");
  `);

  const timedOut = await runtime.exec("while (true) {}");

  const success =
    safeRun.code === 0 &&
    timedOut.code === 124 &&
    (timedOut.errorMessage?.includes("CPU time limit exceeded") ?? false);

  console.log(
    JSON.stringify({
      ok: success,
      safeCode: safeRun.code,
      timeoutCode: timedOut.code,
      errorMessage: timedOut.errorMessage,
      summary: "normal code completed and an infinite loop hit the CPU limit",
    }),
  );
} finally {
  runtime.dispose();
}
