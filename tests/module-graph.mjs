/** Visits a module graph breadth-first, once per module, collecting violations from each inspector call. */
export function walkModules(start, inspect) {
  const modules = new Set();
  const violations = [];
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift();
    if (modules.has(file)) continue;
    modules.add(file);
    const { targets, violations: local } = inspect(file);
    violations.push(...local);
    queue.push(...targets);
  }
  return { modules, violations };
}
