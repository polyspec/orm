import ts from 'typescript';
import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const roots = process.argv.slice(3);
if (roots.length === 0) throw new Error('usage: typescript.mjs <root> <source-root>...');
const files = [];
async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) { if (!(child.includes('/gen/proto/') || child.endsWith('/dist'))) await walk(child); }
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(child);
  }
}
for (const path of roots) await walk(resolve(root, path));
files.sort();
const symbols = {};
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const compact = text => text.replace(/\s+/g, ' ').trim().replace(/ ;$/, ';');
function methodSignature(node, source) {
  const copy = ts.factory.updateMethodDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters, node.type, undefined);
  return compact(printer.printNode(ts.EmitHint.Unspecified, copy, source).replace(/;$/, ''));
}
function functionSignature(node, source) {
  const copy = ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, undefined);
  return compact(printer.printNode(ts.EmitHint.Unspecified, copy, source).replace(/;$/, ''));
}
function fieldType(type) {
  if (!type) return 'unknown';
  if (ts.isArrayTypeNode(type)) return `list<${fieldType(type.elementType)}>`;
  if (ts.isTypeReferenceNode(type) && type.typeName.getText() === 'ReadonlyArray' && type.typeArguments?.length === 1) return `list<${fieldType(type.typeArguments[0])}>`;
  if (ts.isTypeReferenceNode(type) && (type.typeName.getText() === 'Record' || type.typeName.getText() === 'Readonly<Record>')) return `map<${fieldType(type.typeArguments?.[1])}>`;
  if (ts.isTypeLiteralNode(type)) return 'object';
  const text = type.getText();
  if (ts.isLiteralTypeNode(type)) return ts.isNumericLiteral(type.literal) ? 'integer' : 'text';
  if (ts.isUnionTypeNode(type) && type.types.every(item => ts.isLiteralTypeNode(item))) return type.types.every(item => ts.isNumericLiteral(item.literal)) ? 'integer' : 'text';
  if (text === 'string') return 'text';
  if (text === 'boolean') return 'bool';
  if (text === 'number' || text === 'bigint') return 'integer';
  if (text === 'QueryKind') return 'text';
  return text.replace(/\s+/g, '');
}
for (const file of files) {
  const text = await readFile(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const path = relative(root, file);
  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) symbols[`${path}::${node.name.text}`] = functionSignature(node, source);
    if (!((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name)) continue;
    const name = node.name.text;
    const key = `${path}::${name}`;
    symbols[key] = `${ts.isClassDeclaration(node) ? 'class' : 'interface'} ${name}`;
    const wire = {};
    if (ts.isInterfaceDeclaration(node) && node.heritageClauses?.length) {
      const base = node.heritageClauses.flatMap(clause => clause.types).map(type => type.expression.getText(source));
      if (base.length === 1) wire['@flatten'] = base[0];
    }
    for (const member of node.members) {
      if (ts.isConstructorDeclaration(member)) {
        for (const parameter of member.parameters) {
          if (!parameter.modifiers?.length || !ts.isIdentifier(parameter.name)) continue;
          symbols[`${key}#field.${parameter.name.text}`] = parameter.type?.getText(source) ?? 'unknown';
        }
        continue;
      }
      if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
        if (member.name) symbols[`${key}.${member.name.getText(source)}`] = methodSignature(member, source);
      } else if ((ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) && member.name) {
        const field = member.name.getText(source);
        symbols[`${key}#field.${field}`] = member.type?.getText(source) ?? 'unknown';
        if (ts.isInterfaceDeclaration(node)) wire[field] = fieldType(member.type);
      }
    }
    if (Object.keys(wire).length > 0) symbols[`${key}#wire`] = JSON.stringify(wire);
  }
}
process.stdout.write(`${JSON.stringify(symbols, null, 2)}\n`);
