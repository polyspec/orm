// The JSON files of the recipes and their tables: every JSON file under tests/ and contracts/, without build output. A recipe among
// them is a file that names the recipe schema (scripts/features/schema/recipe.schema.json) or whose cases hold steps.
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const BUILD = ['node_modules', 'target', 'vendor', '.venv', 'dist'];

/** jsonFiles lists the JSON files under tests/ and contracts/ of `root`, by path relative to it, in byte order. */
export function jsonFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!BUILD.includes(entry.name)) walk(path);
      } else if (entry.name.endsWith('.json')) found.push(relative(root, path));
    }
  };
  walk(resolve(root, 'tests'));
  walk(resolve(root, 'contracts'));
  return found.sort();
}
