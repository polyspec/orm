// The deadline of a test read: a read that did not stop at its budget would never finish, so it fails with its label.
// Shared by the recipe runner and the catalog_connection coverage, which both bound their streaming reads.
export function within(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no result within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
