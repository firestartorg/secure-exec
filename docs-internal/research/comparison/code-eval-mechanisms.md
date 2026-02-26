# Code Evaluation Mechanisms

Three distinct approaches to running user-provided code, each suited to different use cases.

## 1. Secure Exec SDK (e.g., Secure Exec)

In-process V8 isolates that execute user code with bridged Node.js APIs. The host application embeds the runtime directly — no containers, no deployments, no external services.

**Best for:** mini-sandboxes, user-generated scripts, AI tool execution, plugin systems, template evaluation, lightweight compute tasks.

**Strengths:**
- Low overhead — microsecond startup, no cold boots
- Simple infra — runs inside your existing Node.js process, nothing to deploy or manage
- Flexible — host controls exactly what capabilities are exposed (fs, network, child_process) via driver interfaces
- Cheap — no per-execution billing, no idle VM costs, just memory
- Easy to integrate — `npm install`, pass code as a string, get results back

**Weaknesses:**
- Node.js only — V8 isolates run JavaScript/TypeScript, not Python/Go/Rust/etc.
- Incomplete Node.js surface — bridged APIs cover common stdlib but not everything (no native addons, no worker_threads, partial stream support)
- Single-machine — isolates share the host process, no built-in horizontal distribution
- No OS-level isolation — V8 isolate boundary only, no seccomp/namespaces unless the host process is itself containerized

## 2. Namespaced Deployments (e.g., Fly Machines, Railway, Kubernetes namespaces)

Each user/tenant gets their own deployed application instance — a real container or VM running a full app stack, managed by an orchestrator.

**Best for:** full-blown user applications, multi-tenant SaaS where each tenant runs a customized app, white-label platforms, long-running services.

**Strengths:**
- Full runtime — any language, any framework, any native dependency
- True isolation — process/container/VM boundary with OS-level enforcement
- Horizontal scaling — each deployment scales independently
- Production-grade — real networking, real filesystems, real databases

**Weaknesses:**
- Expensive — per-tenant container/VM costs, idle resource consumption
- Does not have isolation between actors
- Slow to deploy — container builds, image pulls, cold starts (seconds to minutes)
- Operational complexity — orchestrator config, networking, service discovery, health checks, log aggregation per tenant
- Scaling overhead — horizontal scaling means more infra to manage, not just more isolates in a process

## 3. Sandboxes (e.g., E2B, Daytona, Firecracker microVMs)

Ephemeral Linux environments spun up on demand. Full OS with a filesystem, shell, network stack — a real machine, just short-lived.

**Best for:** AI coding agents, interactive development environments, CI/CD, exploratory compute, one-off script execution with full OS access.

**Strengths:**
- Full Linux — any language, any tool, apt-get whatever you need
- Strong isolation — microVM or container boundary, full OS-level sandboxing
- Ephemeral — spin up, run, tear down, no state leaks between executions
- Familiar model — it's just a machine, SSH in or run commands

**Weaknesses:**
- Not suited for production serving — ephemeral by design, no persistent networking, no stable endpoints
- Cold start latency — seconds to spin up a VM, even with snapshots
- Cost per execution — each sandbox is a VM, billed by uptime
- Stateless by default — need explicit mechanisms to persist work across sessions

## When to Use What

| Scenario | Mechanism | Why |
|---|---|---|
| Run a user's JS snippet and return output | Code Eval SDK | Sub-millisecond, no infra, just call `exec()` |
| AI agent executing tool calls | Code Eval SDK | Low latency, many small executions, host controls capabilities |
| Plugin/extension system for a SaaS app | Code Eval SDK | Users write JS hooks, host provides scoped APIs |
| Each customer gets their own app instance | Namespaced Deployments | Full app stack, independent scaling, true isolation |
| White-label platform with custom domains | Namespaced Deployments | Each tenant needs a real running service |
| AI coding agent writing and testing code | Sandboxes | Needs full OS, filesystem, package managers, compilers |
| Interactive cloud IDE | Sandboxes | User expects a real machine with a shell |
| CI/CD pipeline execution | Sandboxes | Arbitrary build tools, system deps, ephemeral environment |
| Run untrusted Python/Go/Rust code | Sandboxes or Namespaced | Code Eval SDK is JS-only |
