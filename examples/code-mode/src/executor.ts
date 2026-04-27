/**
 * SecureExecExecutor — runs LLM-generated code in a Secure Exec V8 isolate.
 *
 * Implements the same Executor interface as @cloudflare/codemode's
 * DynamicWorkerExecutor, but uses Secure Exec instead of Cloudflare Workers.
 *
 * Tool calls from sandboxed code are routed back to the host via a local
 * HTTP RPC server. The sandbox only has network access to localhost.
 */
import {
  NodeRuntime,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "@firestartorg/secure-exec";
import { createServer, type Server } from "node:http";

export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

export interface SecureExecExecutorOptions {
  memoryLimit?: number;
  cpuTimeLimitMs?: number;
}

export class SecureExecExecutor {
  #runtime: NodeRuntime;
  #server: Server | null = null;
  #port = 0;

  constructor(options: SecureExecExecutorOptions = {}) {
    this.#runtime = new NodeRuntime({
      systemDriver: createNodeDriver({
        useDefaultNetwork: true,
        permissions: {
          network: () => ({ allow: true }),
        },
      }),
      runtimeDriverFactory: createNodeRuntimeDriverFactory(),
      memoryLimit: options.memoryLimit ?? 64,
      cpuTimeLimitMs: options.cpuTimeLimitMs ?? 10_000,
    });
  }

  async execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    // Start RPC server for this execution
    const { server, port } = await this.#startRpcServer(fns);

    try {
      const sandboxCode = this.#buildSandboxCode(code, Object.keys(fns), port);

      let resultJson: string | undefined;
      let errorMsg: string | undefined;
      const logs: string[] = [];

      const execResult = await this.#runtime.exec(sandboxCode, {
        onStdio: ({ channel, message }) => {
          if (channel === "stdout" && message.startsWith("__RESULT__")) {
            resultJson = message.slice("__RESULT__".length);
          } else if (channel === "stderr" && message.startsWith("__ERROR__")) {
            errorMsg = message.slice("__ERROR__".length);
          } else {
            logs.push(message);
          }
        },
      });

      if (execResult.code !== 0 || errorMsg) {
        return {
          result: undefined,
          error:
            errorMsg ??
            execResult.errorMessage ??
            `Exit code ${execResult.code}`,
          logs,
        };
      }

      return {
        result: resultJson ? JSON.parse(resultJson) : undefined,
        logs,
      };
    } finally {
      server.close();
    }
  }

  dispose(): void {
    this.#runtime.dispose();
    this.#server?.close();
  }

  #startRpcServer(
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
      const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;

        try {
          const { tool: name, args } = JSON.parse(body);
          const fn = fns[name];
          if (!fn) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Unknown tool: ${name}` }));
            return;
          }
          const result = await fn(args);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            })
          );
        }
      });

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        resolve({ server, port: addr.port });
      });
    });
  }

  #buildSandboxCode(
    userCode: string,
    toolNames: string[],
    port: number
  ): string {
    const proxyMethods = toolNames
      .map((name) => `  ${name}: (input) => rpc('${name}', input)`)
      .join(",\n");

    // Strip markdown code fences LLMs commonly wrap code in
    const cleaned = userCode
      .trim()
      .replace(/^```(?:js|javascript|typescript|ts|tsx|jsx)?\s*\n/, "")
      .replace(/\n?```\s*$/, "")
      .trim();

    return `
async function rpc(toolName, args) {
  const res = await fetch('http://127.0.0.1:${port}', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: toolName, args }),
  });
  const data = JSON.parse(typeof res.text === 'function' ? await res.text() : res.body);
  if (data.error) throw new Error(data.error);
  return data.result;
}

const codemode = {
${proxyMethods}
};

const __fn = ${cleaned};
__fn().then(
  (r) => console.log('__RESULT__' + JSON.stringify(r)),
  (e) => console.error('__ERROR__' + (e && e.message ? e.message : String(e)))
);
`;
  }
}
