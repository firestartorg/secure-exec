/**
 * @secure-exec/os-node
 *
 * Node.js platform adapter — provides filesystem (wrapping node:fs)
 * and worker thread abstractions for the kernel.
 */

export { NodeFileSystem } from "./filesystem.js";
export { NodeWorkerAdapter } from "./worker.js";
