// Formal composition owns the queue and worker. The channel seam only hands
// an already-reserved final result to that active owner.

export async function maybeEmitCompatFinalTurn({
  env,
  message,
  normalizedMessage,
  response,
  outboxItem,
}) {
  const runtime = env?.ombreCompatRuntime;
  if (!runtime?.active) return null;
  if (!outboxItem) return null;
  return runtime.observeReserved({
    message: normalizedMessage || message,
    response,
    outboxItem,
  });
}
