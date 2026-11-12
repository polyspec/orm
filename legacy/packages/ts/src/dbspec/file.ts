// The file reader of dbspec documents (docs/spec/dbspec.md "Files"): it reads the file with the Node file system and checks
// its bytes with readDbspecBytes. It is Node-only, so the browser entry (entry.ts) does not reach it.
import { readFileSync } from 'node:fs';
import { readDbspecBytes, type DbspecReadResult } from './read_bytes.js';

/**
 * Reads the dbspec document file at `path` and checks its bytes with readDbspecBytes, under `path` as its name. A
 * file that cannot be read throws the error readFileSync gives.
 */
export function readDbspecFile(path: string): DbspecReadResult {
  if (typeof path !== 'string') throw new TypeError('dbspec file path must be a string');
  return readDbspecBytes(path, readFileSync(path));
}
