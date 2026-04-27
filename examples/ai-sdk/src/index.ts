import { generateText, stepCountIs, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { NodeRuntime, createNodeDriver, createNodeRuntimeDriverFactory } from "@firestartorg/secure-exec";
import { z } from "zod";

const runtime = new NodeRuntime({
  systemDriver: createNodeDriver({
    permissions: {
      fs: () => ({ allow: true }),
      network: () => ({ allow: true }),
    },
  }),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
  memoryLimit: 64,
  cpuTimeLimitMs: 5000,
});

const { text } = await generateText({
  model: anthropic("claude-sonnet-4-6"),
  prompt: "Calculate the first 20 fibonacci numbers",
  stopWhen: stepCountIs(5),
  tools: {
    execute: tool({
      description: "Run JavaScript in a secure sandbox. Assign the result to module.exports to return data.",
      inputSchema: z.object({ code: z.string() }),
      execute: async ({ code }) => runtime.run(code),
    }),
  },
});

console.log(text);
