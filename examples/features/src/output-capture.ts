import {
  NodeRuntime,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "../../../packages/secure-exec/src/index.ts";

const events: string[] = [];

const runtime = new NodeRuntime({
  systemDriver: createNodeDriver(),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
});

try {
  const result = await runtime.exec(
    `
      console.log("hello from the sandbox");
      console.error("oops from the sandbox");
    `,
    {
      onStdio: (event) => {
        events.push(`[${event.channel}] ${event.message}`);
      },
    }
  );

  if (result.code !== 0) {
    throw new Error(`Unexpected execution result: ${JSON.stringify(result)}`);
  }

  const expected = [
    "[stdout] hello from the sandbox",
    "[stderr] oops from the sandbox",
  ];

  if (JSON.stringify(events) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected stdio events: ${JSON.stringify(events)}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      events,
      summary: "captured stdout and stderr with onStdio",
    }),
  );
} finally {
  runtime.dispose();
}
