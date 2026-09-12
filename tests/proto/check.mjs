import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const file = 'proto/orm/compiler/v1/compiler.proto';
const source = await readFile(file, 'utf8');
for (const required of [
  'service CompilerService',
  'rpc Compile(CompileRequest) returns (CompileResponse)',
  'rpc GetMetadata(GetMetadataRequest) returns (GetMetadataResponse)',
  'message CompileRequest',
  'message QueryNode',
  'message Predicate',
  'message Assignment',
  'message Plan',
  'message CompileError',
  'optional uint32 scope_parameter = 20',
  'string aggregate = 10',
  'bool debug = 11',
  'message ParentReference',
  'message ParentCondition',
  'message Assemble',
  'repeated KeyReference key = 5',
  'message OutputColumn',
  'message Child',
  'oneof value',
  'oneof result',
]) {
  if (!source.includes(required)) throw new Error(`${file}: missing ${required}`);
}
if (/google\.protobuf\.(Struct|Any)|json_payload|ir_json/.test(source)) throw new Error(`${file}: untyped payload field is forbidden`);
for (const generated of [
  'proto/orm/compiler/v1/compiler.pb.go',
  'clients/php/src/Proto/Orm/Compiler/V1/QueryNode.php',
  'clients/rust/orm/src/gen/orm/compiler/v1/orm.compiler.v1.rs',
  'clients/typescript/src/gen/proto/orm/compiler/v1/compiler_pb.ts',
]) {
  const text = await readFile(generated, 'utf8');
  if (!text.includes('scope_parameter') && !text.includes('ScopeParameter') && !text.includes('scopeParameter')) throw new Error(`${generated}: scope parameter is missing`);
}
const manifest = JSON.parse(await readFile('proto/generated.sha256.json', 'utf8'));
if (manifest.version !== 1 || Object.keys(manifest.files).length < 10) throw new Error('proto/generated.sha256.json is incomplete');
for (const [generated, expected] of Object.entries(manifest.files)) {
  const actual = createHash('sha256').update(await readFile(generated)).digest('hex');
  if (actual !== expected) throw new Error(`${generated}: generated protobuf hash mismatch; run scripts/proto/generate.sh`);
}

const interfaces = JSON.parse(await readFile('contracts/interfaces.json', 'utf8'));
const transport = interfaces.compiler_transport;
if (transport?.service !== 'orm.compiler.v1.CompilerService' || transport.path !== '/orm.compiler.v1.CompilerService/') {
  throw new Error('contracts/interfaces.json: invalid compiler transport service');
}
if (Object.keys(transport.native ?? {}).sort().join(',') !== 'go,php,rust,typescript') {
  throw new Error('contracts/interfaces.json: compiler transport must map go, php, rust, and typescript');
}
const compile = transport.operations?.compile;
const metadata = transport.operations?.metadata;
if (compile?.input !== 'CompileRequest' || compile.output !== 'Plan' || compile.error !== 'CompileError' || metadata?.input !== 'GetMetadataRequest' || metadata.output !== 'GetMetadataResponse') {
  throw new Error('contracts/interfaces.json: invalid compiler transport operations');
}
const compact = (value) => value.replace(/\s+/g, ' ');
const declarations = {};
for (const [language, native] of Object.entries(transport.native)) {
  declarations[language] = compact(await readFile(native.file, 'utf8'));
}
for (const [language, expected] of Object.entries({
  go: ['type CompilerTransport interface { Compile(context.Context, *compilerv1.CompileRequest) (*compilerv1.Plan, error) Metadata(context.Context) (*compilerv1.GetMetadataResponse, error) }', 'var _ CompilerTransport = (*ConnectCompiler)(nil)'],
  php: ['interface CompilerTransport', 'public function compile(CompileRequest $request): Plan;', 'public function metadata(): GetMetadataResponse;'],
  rust: ['pub trait CompilerTransport: Send + Sync', 'async fn compile(&self, request: CompileRequest) -> Result<Plan>;', 'async fn metadata(&self) -> Result<GetMetadataResponse>;'],
  typescript: ['export interface CompilerTransport {', 'compile(request: CompileRequest): Promise<Plan>;', 'metadata(): Promise<GetMetadataResponse>;', 'export class ConnectCompiler implements CompilerTransport'],
})) {
  for (const text of expected) {
    if (!declarations[language].includes(text)) throw new Error(`${transport.native[language].file}: missing ${text}`);
  }
}
const phpImplementation = compact(await readFile(transport.native.php.implementation_file, 'utf8'));
if (!phpImplementation.includes('final class ConnectCompiler implements CompilerTransport')) throw new Error(`${transport.native.php.implementation_file}: CompilerTransport is not implemented`);
if (!declarations.rust.includes('impl CompilerTransport for ConnectCompiler')) throw new Error(`${transport.native.rust.file}: CompilerTransport is not implemented`);

console.log(`proto: typed declarations, generated hashes, and 4 compiler transport interfaces passed`);
