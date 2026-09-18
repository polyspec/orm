// Collects the method names that consumer sources call on any object.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import ts from 'typescript';

const kinds: Readonly<Record<string, ts.ScriptKind>> = {
  '.ts': ts.ScriptKind.TS, '.mts': ts.ScriptKind.TS, '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS,
};

const skipped = new Set(['node_modules', 'dist']);

function visitFile(path: string, names: Set<string>): void {
  const kind = kinds[extname(path)];
  if (kind === undefined) return;
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, false, kind);
  const visit = (node: ts.Node): void => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isPropertyAccessExpression(node.expression)) {
      names.add(node.expression.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function visitDir(dir: string, names: Set<string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name)) visitDir(path, names);
    } else if (entry.isFile()) visitFile(path, names);
  }
}

/** Returns the sorted names of the methods the sources call. */
export function scanCallNames(paths: readonly string[]): string[] {
  const names = new Set<string>();
  for (const path of paths) {
    if (statSync(path).isDirectory()) visitDir(path, names);
    else visitFile(path, names);
  }
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
