/**
 * @secure-exec/os-browser
 *
 * Browser platform adapter — provides in-memory/OPFS filesystem
 * and Web Worker abstractions for the kernel.
 */

export { InMemoryFileSystem } from "./filesystem.js";
export { BrowserWorkerAdapter } from "./worker.js";
