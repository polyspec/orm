// The models that the TypeScript build generates into packages/ts/src/models (P34: generated output is never tracked). build.mts runs orm-gen
// with each entry, and the tests of the client read the arguments of the first entry. Paths are relative to packages/ts, where orm-gen runs.

export interface GeneratedModels {
  /** The directory that orm-gen writes its models.ts into. */
  readonly out: string;
  /** The dbspec document set file. */
  readonly set: string;
  /** The sources that orm-gen scans for the chain methods that they call on the models. */
  readonly scans: readonly string[];
}

const clientScans = [
  'testing/conformance/runner_typescript.mts', 'tests/chain-null.mjs', 'tests/coverage_composite_keys.mjs', 'tests/coverage_constraints_and_relations.mjs',
  'tests/coverage_dsn.mjs', 'tests/coverage_model_queries.mjs', 'tests/coverage_model_writes.mjs', 'tests/coverage_parameter_chunking.mjs',
  'tests/coverage_schema_install.mjs', 'tests/coverage_transactions.mjs', 'tests/decimal_model_type.ts', 'tests/group_rows.types.ts', 'tests/group_rows_db.mjs',
  'tests/model.mjs', 'tests/sqlite-concurrency.mjs', 'tests/styled-value-checks.mjs', 'tests/transaction-flow.mjs', 'tests/typecheck.ts',
  '../../examples/thin-slice/ts/main.mts',
];

/** The client's own models first, then the decimal and Markdown fixtures. */
export const generatedModels: readonly GeneratedModels[] = [
  { out: 'src/models', set: '../../contracts/fixtures/bench/dbspec-set.json', scans: clientScans },
  { out: 'src/models/decimal_fixture', set: '../../contracts/fixtures/dbspec-set.json', scans: ['tests/decimal_model_db.mjs'] },
  { out: 'src/models/markdown_fixture', set: '../../tests/markdown/corpus/dbspec/dbspec-set.json', scans: ['tests/markdown_cases.mjs'] },
];

/** The orm-gen arguments that write one entry, the subcommand first. */
export function generatorArgs(model: GeneratedModels): string[] {
  return ['gen', '--set', model.set, '--out', model.out, ...model.scans.flatMap(scan => ['--scan', scan])];
}
