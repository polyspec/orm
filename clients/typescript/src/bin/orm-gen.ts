#!/usr/bin/env node
// orm-gen entry point. Node 22 reports node:sqlite as an experimental feature
// on stderr when the module loads; the entry drops that one warning before the
// tool loads, so the tool writes the same output on every supported Node.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const kind = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  const text = typeof warning === 'string' ? warning : warning.message;
  if (kind === 'ExperimentalWarning' && text.startsWith('SQLite ')) return;
  return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;

await import('../tools/cli.js');
