import ts from 'typescript';
import { readFile } from 'node:fs/promises';

const file = 'clients/typescript/src/index.ts';
const source = await readFile(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declarations = new Map();
for (const node of ast.statements) {
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isFunctionDeclaration(node)) {
    const name = node.name?.text;
    if (name) declarations.set(name, node);
  }
}
for (const name of ['AesRotationColumn', 'AesRowCodec', 'AesKeyring', 'Request', 'Group', 'Predicate', 'Relation', 'Plan', 'Compiler', 'Executor', 'Database', 'BattleRow', 'Where', 'BattleQuery', 'UserQuery', 'ServiceQuery', 'ServiceModuleQuery', 'ServiceMemberQuery']) {
  if (!declarations.has(name)) throw new Error(`${file}: missing declaration ${name}`);
}
const query = declarations.get('BattleQuery');
const methods = query.members.filter(ts.isMethodDeclaration).map(node => node.name.getText(ast));
const required = ['using', 'serviceSeqEq', 'isCloseEq', 'isDisplayEq', 'isAlldayEq', 'and', 'or', 'relation', 'get', 'gets', 'getCount'];
for (const name of required) if (!methods.includes(name)) throw new Error(`${file}: BattleQuery missing method ${name}`);
if (!methods.includes('scope')) throw new Error(`${file}: BattleQuery missing method scope`);
const positions = required.map(name => methods.indexOf(name));
if (positions.some((position, i) => i > 0 && position <= positions[i - 1])) throw new Error(`${file}: method order differs from the common query flow`);
if (!declarations.has('Battle') || !ts.isFunctionDeclaration(declarations.get('Battle'))) throw new Error(`${file}: missing Battle factory`);
for (const name of ['User', 'Service', 'ServiceModule', 'ServiceMember']) {
  if (!declarations.has(name) || !ts.isFunctionDeclaration(declarations.get(name))) throw new Error(`${file}: missing ${name} factory`);
}
if (!source.includes("scope is not declared for")) throw new Error(`${file}: scope guard is missing for entities without a scope directive`);
const keyring = declarations.get('AesKeyring');
const rotation = keyring.members.filter(ts.isMethodDeclaration).map(node => node.name.getText(ast));
for (const name of ['versions', 'rotateRow']) if (!rotation.includes(name)) throw new Error(`${file}: AesKeyring missing ${name}`);
console.log(`typescript: ${file} declarations and query flow passed`);
