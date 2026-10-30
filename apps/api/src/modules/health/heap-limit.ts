/**
 * The heap size above which /health reports memory_heap as down (and so answers 503). Default 1 GiB, unchanged for production.
 * HEALTH_HEAP_LIMIT_MB overrides it (128 or more; anything else is ignored). The automated end-to-end run sets it high because one process
 * runs every suite, so its heap is far above what a single API instance uses and would otherwise fail the health test for reasons that
 * have nothing to do with the code under test.
 */
export const DEFAULT_HEAP_LIMIT_BYTES = 1024 * 1024 * 1024;
const MIN_HEAP_LIMIT_MB = 128;

export function heapLimitBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.HEALTH_HEAP_LIMIT_MB ?? '').trim();
  if (!/^\d{1,6}$/.test(raw)) return DEFAULT_HEAP_LIMIT_BYTES;
  const mb = Number(raw);
  return mb >= MIN_HEAP_LIMIT_MB ? mb * 1024 * 1024 : DEFAULT_HEAP_LIMIT_BYTES;
}
