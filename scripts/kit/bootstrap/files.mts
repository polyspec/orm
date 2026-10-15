// Reading and writing files: a JSON file, and a file that a reader never finds half written.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Whether `value` is a JSON list, whose items are still unknown. */
export const isJsonList = (value: unknown): value is unknown[] => Array.isArray(value);

/** Whether `value` is a JSON list of strings. */
export const isStringList = (value: unknown): value is string[] => isJsonList(value) && value.every(item => typeof item === 'string');

/** Whether `value` is a JSON object: neither null nor an array. */
export const isJsonObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The JSON object of the file at the joined path `parts`; throws with the file when it holds another JSON value. The bootstrap
 * runs before the packages, ajv among them, are installed, so its modules read each field of the object with a check of
 * their own; every other tool reads JSON through a schema (scripts/kit/schema-validate.mts, K158).
 */
export function readJsonObject(...parts: string[]): Record<string, unknown> {
  const value = readJson(...parts);
  if (!isJsonObject(value)) throw new Error(`${path.join(...parts)} holds no JSON object: ${JSON.stringify(value)}`);
  return value;
}

/** The JSON value of the file at the joined path `parts`. */
// JSON of any shape: a caller states the shape that it reads.
export const readJson = (...parts: string[]): unknown => JSON.parse(readFileSync(path.join(...parts), 'utf8'));

/** Writes `content` to `file` through a file of this process beside it and a rename; creates the directory; `mode` sets the file mode. */
export function writeAtomic(file: string, content: string | NodeJS.ArrayBufferView, { mode }: { mode?: number | undefined } = {}): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const next = `${file}.next-${process.pid}`;
  writeFileSync(next, content);
  if (mode !== undefined) chmodSync(next, mode);
  renameSync(next, file);
}

/** The text of `value` as a JSON file: two spaces of indentation and a final line break. */
export const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Writes `value` to the JSON file `file` as `writeAtomic` does. */
export const writeJson = (file: string, value: unknown): void => writeAtomic(file, jsonText(value));
