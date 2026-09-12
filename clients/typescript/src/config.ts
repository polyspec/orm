import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parse } from 'smol-toml';
import { OrmError } from './runtime_error.js';

type Section = Record<string, unknown>;
export interface FileConfig {
  schema: string;
  db: { driver: 'mysql' | 'postgres' | 'sqlite'; dsn: string; user?: string; password?: string; pool: number };
  secrets: { aes?: string; aes_env?: string };
  engine: { wasm?: string; cache_dir?: string };
  ormd: { endpoint: string; timeout_ms: number; socket?: string };
  debug: { on_query: boolean };
}

function fail(message: string): never { throw new OrmError('CONFIG', message); }
function object(value: unknown, key: string): Section {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${key} must be a table`);
  return value as Section;
}
function keys(value: Section, allowed: readonly string[], key: string): void {
  for (const name of Object.keys(value)) if (!allowed.includes(name)) fail(`unknown key ${key}${name}`);
}
function string(value: unknown, key: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value === '') fail(`${key} must be a non-empty string`);
  return value;
}
function integer(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail(`${key} must be a positive integer`);
  return value;
}
async function declaredPath(value: string, key: string): Promise<void> {
  if (!isAbsolute(value)) fail(`${key}: ${value} is not absolute`);
  let stat;
  try { stat = await lstat(value); } catch (error) { fail(`${key}: ${value}: ${(error as Error).message}`); }
  if (stat.isSymbolicLink()) fail(`${key}: ${value} is a symlink`);
}

export async function loadConfig(path: string): Promise<FileConfig> {
  await declaredPath(path, 'config');
  let source: Section;
  try { source = object(parse(await readFile(path, 'utf8')), path); } catch (error) {
    if (error instanceof OrmError) throw error;
    fail(`${path}: ${(error as Error).message}`);
  }
  keys(source, ['schema', 'db', 'secrets', 'engine', 'ormd', 'debug'], '');
  const schema = string(source.schema, 'schema', true)!;
  await declaredPath(schema, 'schema');
  const db = object(source.db, 'db');
  const secrets = object(source.secrets, 'secrets');
  const engine = object(source.engine, 'engine');
  const ormd = object(source.ormd, 'ormd');
  const debug = object(source.debug, 'debug');
  keys(db, ['driver', 'dsn', 'user', 'password', 'pool'], 'db.');
  keys(secrets, ['aes', 'aes_env'], 'secrets.');
  keys(engine, ['wasm', 'cache_dir'], 'engine.');
  keys(ormd, ['endpoint', 'timeout_ms', 'socket'], 'ormd.');
  keys(debug, ['on_query'], 'debug.');
  const driver = string(db.driver, 'db.driver') ?? 'mysql';
  if (!['mysql', 'postgres', 'sqlite'].includes(driver)) fail('db.driver must be mysql, postgres or sqlite');
  const dsn = string(db.dsn, 'db.dsn', true)!;
  if (driver === 'sqlite') await declaredPath(dsn, 'db.dsn');
  const user = string(db.user, 'db.user');
  const password = db.password === undefined ? undefined : typeof db.password === 'string' ? db.password : fail('db.password must be a string');
  if (driver !== 'mysql' && (user !== undefined || password !== undefined)) fail(`db.user and db.password do not apply to ${driver}`);
  const aes = secrets.aes === undefined ? undefined : typeof secrets.aes === 'string' ? secrets.aes : fail('secrets.aes must be a string');
  const aesEnv = string(secrets.aes_env, 'secrets.aes_env');
  if (aes !== undefined && aesEnv !== undefined) fail('secrets.aes and secrets.aes_env are exclusive');
  const wasm = string(engine.wasm, 'engine.wasm');
  const cacheDir = string(engine.cache_dir, 'engine.cache_dir');
  const socket = string(ormd.socket, 'ormd.socket');
  for (const [key, value] of [['engine.wasm', wasm], ['engine.cache_dir', cacheDir], ['ormd.socket', socket]] as const) if (value !== undefined) await declaredPath(value, key);
  const endpoint = string(ormd.endpoint, 'ormd.endpoint', true)!;
  if (typeof debug.on_query !== 'undefined' && typeof debug.on_query !== 'boolean') fail('debug.on_query must be a boolean');
  return {
    schema,
    db: { driver: driver as FileConfig['db']['driver'], dsn, user, password, pool: integer(db.pool, 'db.pool', 8) },
    secrets: { aes, aes_env: aesEnv }, engine: { wasm, cache_dir: cacheDir },
    ormd: { endpoint, timeout_ms: integer(ormd.timeout_ms, 'ormd.timeout_ms', 5_000), socket },
    debug: { on_query: debug.on_query === true },
  };
}

export function resolveAesKey(config: FileConfig): string {
  if (config.secrets.aes_env === undefined) return config.secrets.aes ?? '';
  const value = process.env[config.secrets.aes_env];
  if (!value) fail(`environment variable ${config.secrets.aes_env} (secrets.aes_env) is empty`);
  return value;
}
