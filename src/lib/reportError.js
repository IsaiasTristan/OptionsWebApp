/**
 * Small observability helper — never swallow errors without a trace.
 * @param {string} context
 * @param {unknown} err
 */
export function reportError(context, err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[OPTIX] ${context}:`, message, err instanceof Error ? err.stack : "");
}
