// The copies of @polyspec/kit in this checkout: kit.copies of the package.json of the installed package maps each copy to its
// file in the package. make kit-sync writes them and make kit-check holds them byte for byte; they are kit's, so the rules of
// this repository skip them.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** The copies of the @polyspec/kit installed for the checkout `root`, as { copy path: package path }. */
export function kitCopies(root: string): Record<string, string> {
  let manifest: string;
  try {
    manifest = createRequire(join(root, 'package.json')).resolve('@polyspec/kit/package.json');
  } catch (error) {
    throw new Error(`@polyspec/kit is not installed (${(error as NodeJS.ErrnoException).code ?? String(error)}); run make install-tools TOOLS=npm, then make install-packages`);
  }
  const copies: unknown = JSON.parse(readFileSync(manifest, 'utf8')).kit?.copies;
  if (copies === null || typeof copies !== 'object') throw new Error(`${manifest} declares no kit.copies; install a release of @polyspec/kit`);
  return copies as Record<string, string>;
}
