// Reading and writing files: a JSON file, and a file that a reader never finds half written.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The JSON value of the file at the joined path `parts`. */
// JSON of any shape; any rather than unknown because 127 call sites in other groups read fields without narrowing yet.
export const readJson = (...parts: string[]): any => JSON.parse(readFileSync(path.join(...parts), 'utf8'));

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
