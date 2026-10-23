import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

// typescript is a dependency of the packages/ts/testing/interfaces/typescript project (TypeScript 6.0.3, an exception in config/toolchain.json): it is found from that project.
// make orm-install-interfaces-typescript installs it; the import gives the compiler API with its declarations.
type Node = import('typescript').Node;
type SourceFile = import('typescript').SourceFile;
type TypeNode = import('typescript').TypeNode;
type MethodLike = import('typescript').MethodDeclaration | import('typescript').MethodSignature;
type ConstructorDeclaration = import('typescript').ConstructorDeclaration;
type FunctionDeclaration = import('typescript').FunctionDeclaration;
type Declaration = import('typescript').Declaration;
type CompilerApi = typeof import('typescript');
const ts: CompilerApi = (await import('./typescript/node_modules/typescript/lib/typescript.js')).default;
// isDeclaration is a node whose modifiers the compiler combines: a declaration statement, a class element, or a variable,
// parameter, enum member, type parameter or binding element.
const isDeclaration = (node: Node): node is Declaration => ts.isDeclarationStatement(node) || ts.isClassElement(node) || ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isEnumMember(node) || ts.isTypeParameterDeclaration(node) || ts.isBindingElement(node);

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
// modifierFlags are the combined modifiers of a declaration; a node that is no declaration carries none.
const modifierFlags = (node: Node): number => (isDeclaration(node) ? ts.getCombinedModifierFlags(node) : 0);
const hasExport = (node: Node): boolean => (modifierFlags(node) & ts.ModifierFlags.Export) !== 0;
const hidden = (node: Node): boolean => (modifierFlags(node) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0;
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const compact = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/ ;$/, ';');
function methodSignature(node: MethodLike, source: SourceFile): string {
  const copy: Node = ts.isMethodDeclaration(node)
    ? ts.factory.updateMethodDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters, node.type, undefined)
    : node;
  return compact(printer.printNode(ts.EmitHint.Unspecified, copy, source).replace(/;$/, ''));
}
function constructorSignature(node: ConstructorDeclaration, source: SourceFile): string {
  const copy = ts.factory.updateConstructorDeclaration(node, node.modifiers, node.parameters, undefined);
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
    const constructors = ts.isClassDeclaration(node) ? node.members.filter(ts.isConstructorDeclaration) : [];
    // Keep private and protected access visible so a restriction change alters the class symbol signature.
    // When overload signatures exist, the implementation is not part of the constructor contract.
    const overloads = constructors.filter(member => member.body === undefined);
    const selectedConstructors = overloads.length > 0 ? overloads : constructors;
    const constructorSignatures = selectedConstructors.map(member => constructorSignature(member, source));
    const classSignature = `${ts.isClassDeclaration(node) ? 'class' : 'interface'} ${name}${constructorSignatures.length > 0 ? ` { ${constructorSignatures.join('; ')}; }` : ''}`;
    put(key, classSignature, exported);
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
