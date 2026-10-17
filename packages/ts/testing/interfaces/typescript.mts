import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

// typescript는 packages/ts/testing/interfaces/typescript project의 dependency다(TypeScript 6.0.3, config/toolchain.json의 예외): 그 project에서 찾는다.
// make install-interfaces-typescript installs it; the import of its file gives the compiler API with its declarations.
const ts = (await import('./typescript/node_modules/typescript/lib/typescript.js')).default;
type Node = import('./typescript/node_modules/typescript/lib/typescript.js').Node;
type SourceFile = import('./typescript/node_modules/typescript/lib/typescript.js').SourceFile;
type TypeNode = import('./typescript/node_modules/typescript/lib/typescript.js').TypeNode;
type MethodLike = import('./typescript/node_modules/typescript/lib/typescript.js').MethodDeclaration | import('./typescript/node_modules/typescript/lib/typescript.js').MethodSignature;
type FunctionDeclaration = import('./typescript/node_modules/typescript/lib/typescript.js').FunctionDeclaration;

const root = resolve(process.argv[2] ?? '.');
const roots = process.argv.slice(3);
if (roots.length === 0) throw new Error('usage: typescript.mts <root> <source-root>...');
const files: string[] = [];
async function walk(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) { if (!(child.includes('/gen/proto/') || child.endsWith('/dist'))) await walk(child); }
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(child);
  }
}
for (const path of roots) await walk(resolve(root, path));
files.sort();
// A symbol is exported when its declaration carries the export modifier, and a class member when, in addition, it is neither
// private, protected nor a private name (#name). An interface member is exported with its interface.
type Entry = { signature: string; exported: boolean };
const symbols: Record<string, Entry> = {};
const put = (key: string, signature: string, exported: boolean) => { symbols[key] = { signature, exported }; };
const hasExport = (node: Node): boolean => (ts.getCombinedModifierFlags(node as import('./typescript/node_modules/typescript/lib/typescript.js').Declaration) & ts.ModifierFlags.Export) !== 0;
const hidden = (node: Node): boolean => (ts.getCombinedModifierFlags(node as import('./typescript/node_modules/typescript/lib/typescript.js').Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0;
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const compact = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/ ;$/, ';');
function methodSignature(node: MethodLike, source: SourceFile): string {
  const copy: Node = ts.isMethodDeclaration(node)
    ? ts.factory.updateMethodDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters, node.type, undefined)
    : node;
  return compact(printer.printNode(ts.EmitHint.Unspecified, copy, source).replace(/;$/, ''));
}
function functionSignature(node: FunctionDeclaration, source: SourceFile): string {
  const copy = ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, undefined);
  return compact(printer.printNode(ts.EmitHint.Unspecified, copy, source).replace(/;$/, ''));
}
function fieldType(type: TypeNode | undefined): string {
  if (!type) return 'unknown';
  if (ts.isArrayTypeNode(type)) return `list<${fieldType(type.elementType)}>`;
  if (ts.isTypeReferenceNode(type) && type.typeName.getText() === 'ReadonlyArray' && type.typeArguments?.length === 1) return `list<${fieldType(type.typeArguments[0])}>`;
  if (ts.isTypeReferenceNode(type) && (type.typeName.getText() === 'Record' || type.typeName.getText() === 'Readonly<Record>')) return `map<${fieldType(type.typeArguments?.[1])}>`;
  if (ts.isTypeLiteralNode(type)) return 'object';
  const text = type.getText();
  if (ts.isLiteralTypeNode(type)) return ts.isNumericLiteral(type.literal) ? 'integer' : 'text';
  if (ts.isUnionTypeNode(type) && type.types.every(item => ts.isLiteralTypeNode(item))) return type.types.every(item => ts.isLiteralTypeNode(item) && ts.isNumericLiteral(item.literal)) ? 'integer' : 'text';
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
    if (ts.isFunctionDeclaration(node) && node.name) put(`${path}::${node.name.text}`, functionSignature(node, source), hasExport(node));
    if (!((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name)) continue;
    const name = node.name.text;
    const key = `${path}::${name}`;
    const exported = hasExport(node);
    put(key, `${ts.isClassDeclaration(node) ? 'class' : 'interface'} ${name}`, exported);
    const wire: Record<string, string> = {};
    if (ts.isInterfaceDeclaration(node) && node.heritageClauses?.length) {
      const base = node.heritageClauses.flatMap(clause => clause.types).map(type => type.expression.getText(source));
      if (base.length === 1 && base[0] !== undefined) wire['@flatten'] = base[0];
    }
    for (const member of node.members) {
      if (ts.isConstructorDeclaration(member)) {
        for (const parameter of member.parameters) {
          if (!parameter.modifiers?.length || !ts.isIdentifier(parameter.name)) continue;
          put(`${key}#field.${parameter.name.text}`, parameter.type?.getText(source) ?? 'unknown', exported && !hidden(parameter));
        }
        continue;
      }
      if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
        if (member.name) put(`${key}.${member.name.getText(source)}`, methodSignature(member, source), exported && !hidden(member) && !ts.isPrivateIdentifier(member.name));
      } else if ((ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) && member.name) {
        const field = member.name.getText(source);
        put(`${key}#field.${field}`, member.type?.getText(source) ?? 'unknown', exported && !hidden(member) && !ts.isPrivateIdentifier(member.name));
        if (ts.isInterfaceDeclaration(node)) wire[field] = fieldType(member.type);
      }
    }
    if (Object.keys(wire).length > 0) put(`${key}#wire`, JSON.stringify(wire), exported);
  }
}
process.stdout.write(`${JSON.stringify(symbols, null, 2)}\n`);
