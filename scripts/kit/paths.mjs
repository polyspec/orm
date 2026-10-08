// Where a tool of scripts/kit runs: the root of the checkout that holds scripts/kit, and whether a module is the command
// that Node.js started.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The root of the checkout that holds scripts/kit. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Whether the module `moduleUrl` (its `import.meta.url`) is the command that Node.js started. */
export const isMain = moduleUrl => Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
