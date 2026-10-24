/** Returns a failure value, optionally rethrowing failures outside the accepted type. */
export async function captureError(run, accepts = () => true) {
  try { await run(); return null; }
  catch (error) { if (accepts(error)) return error; throw error; }
}
