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

/** Collects resolved targets and violations from one import resolver per scanned import. */
export function resolveImports(imports, resolve) {
  const targets = [];
  const violations = [];
  for (const { specifier, at } of imports) {
    const result = resolve(specifier, at);
    if (result.target !== undefined) targets.push(result.target);
    if (result.violation !== undefined) violations.push(result.violation);
  }
  return { targets, violations };
}
