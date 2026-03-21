/**
 * @deprecated Canonical source moved to @secure-exec/node (kernel-runtime.ts).
 * This file re-exports for backward compatibility.
 */
export {
  createNodeRuntime,
  createKernelCommandExecutor,
  createKernelVfsAdapter,
  createHostFallbackVfs,
} from '@secure-exec/node';
export type { NodeRuntimeOptions } from '@secure-exec/node';
