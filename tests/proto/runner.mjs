import { ConnectCompiler, CompilerProto, compileRequest } from '../../clients/typescript/dist/index.js';

const endpoint = process.argv[2];
if (!endpoint) throw new Error('endpoint required');
const compiler = new ConnectCompiler(endpoint);
const metadata = await compiler.metadata();
const request = compileRequest({
  irVersion: 1,
  schemaHash: metadata.schemaHash,
  kind: CompilerProto.QueryKind.COUNT,
  parameterCount: 2,
  root: {
    entity: 'battle',
    scopeParameter: 0,
    where: { items: [{ value: { case: 'predicate', value: { column: 'service_seq', operator: 'eq', parameter: 1 } } }] },
  },
});
const plan = await compiler.compile(request);
const step = plan.steps[0];
console.log(JSON.stringify({
  schema_hash: metadata.schemaHash,
  dialect: metadata.dialect,
  ir_version: metadata.irVersion,
  sql: step.sql,
  bind_parameters: step.binds.map(bind => bind.parameter),
  output_columns: step.assemble?.columns.length ?? 0,
}));
