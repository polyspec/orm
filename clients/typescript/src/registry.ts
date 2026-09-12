import { OrmError } from './runtime_error.js';

let schemaHash = '';

export function registerSchemaHash(value: string): void {
  if (schemaHash !== '' && schemaHash !== value) throw new OrmError('SCHEMA_HASH_MISMATCH', `generated schemas ${schemaHash} and ${value} were loaded together`);
  schemaHash = value;
}

export function generatedSchemaHash(): string {
  if (schemaHash === '') throw new OrmError('CONFIG', 'generated entities must be imported before opening orm.toml');
  return schemaHash;
}
