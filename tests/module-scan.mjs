import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { parseSync, visitorKeys } from 'oxc-parser';

const forbiddenGlobals = new Set(['Buffer', 'process', '__dirname', 'require']);

function isReference(node, parent) {
  if (parent.type === 'MemberExpression' && !parent.computed && parent.property === node) return false;
  if (parent.type === 'Property' && !parent.computed && !parent.shorthand && parent.key === node) return false;
  if ((parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition' || parent.type === 'AccessorProperty') && !parent.computed && parent.key === node) return false;
  return true;
}

function literal(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
}

/** Reads a JavaScript module's literal imports and forbidden Node global references. */
export function scanModule(file, relativeRoot) {
  const text = readFileSync(file, 'utf8');
  const parsed = parseSync(file, text);
  assert.deepEqual(parsed.errors.map(error => error.message), [], `${relative(relativeRoot, file)} parses`);
  const where = node => {
    const before = text.slice(0, node.start).split('\n');
    return `${relative(relativeRoot, file)}:${before.length}:${before.at(-1).length + 1}`;
  };
  const imports = [];
  const violations = [];
  const visit = (node, parent) => {
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
      imports.push({ specifier: node.source.value, at: where(node) });
    } else if (node.type === 'ImportExpression') {
      const specifier = literal(node.source);
      if (specifier !== undefined) imports.push({ specifier, at: where(node) });
      else violations.push(`${where(node)} dynamic import with no literal specifier cannot be followed`);
    } else if (node.type === 'Identifier' && forbiddenGlobals.has(node.name) && isReference(node, parent)) {
      violations.push(`${where(node)} uses the Node global ${node.name}`);
    }
    for (const key of visitorKeys[node.type] ?? []) {
      for (const child of [node[key]].flat()) if (child) visit(child, node);
    }
  };
  visit(parsed.program, undefined);
  return { imports, violations };
}
