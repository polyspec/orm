// Where a tool of scripts/kit runs: the root of the checkout that holds scripts/kit, and whether a module is the command
// that Node.js started.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The root of the checkout that holds scripts/kit. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Whether the module `moduleUrl` (its `import.meta.url`) is the command that Node.js started. Both paths are resolved to their real
 * files before the comparison, so a command named through a link of its directory is that module; the comparison never reads a
 * link as a different file, which would make the tool skip its work and exit 0.
 */
export const isMain = moduleUrl => Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
