import { readFile } from 'node:fs/promises';

const file = 'proto/orm/compiler/v1/compiler.proto';
const source = await readFile(file, 'utf8');
for (const required of [
  'service CompilerService',
  'rpc Compile(CompileRequest) returns (CompileResponse)',
  'message CompileRequest',
  'message QueryNode',
  'message Predicate',
  'message Assignment',
  'message Plan',
  'message CompileError',
]) {
  if (!source.includes(required)) throw new Error(`${file}: missing ${required}`);
}
if (/google\.protobuf\.(Struct|Any)|json_payload|ir_json/.test(source)) throw new Error(`${file}: untyped payload field is forbidden`);
console.log(`proto: ${file} typed message declarations passed`);
