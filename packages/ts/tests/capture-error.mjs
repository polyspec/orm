/** Returns a failure value, optionally rethrowing failures outside the accepted type. */
export async function captureError(run, options = {}) {
  const accepts = options.accepts ?? (() => true);
  const success = Object.hasOwn(options, 'success') ? options.success : null;
  try { await run(); return success; }
  catch (error) { if (accepts(error)) return error; throw error; }
}
