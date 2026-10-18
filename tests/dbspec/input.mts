// The tests/dbspec runners read input files. An unreadable input writes "<path>: <reason>"
// to stderr and exits 1.
import { readFileSync } from 'node:fs';
import { errorMessage } from '../errors.mts';

// readInput returns the UTF-8 content of path; if it cannot be read, it writes that path and the reason and ends.
export function readInput(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    console.error(`${path}: ${errorMessage(error)}`);
    process.exit(1);
  }
}
