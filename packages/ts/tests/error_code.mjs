/** Returns an ORM error code or the string form of another rejected value. */
export async function codeOf(promise, OrmError) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof OrmError ? error.code : String(error);
  }
}
