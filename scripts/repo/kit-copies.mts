// The copies of @polyspec/kit in this checkout: kit.copies of the package.json of the installed package maps each copy to its
// file in the package. make kit-sync writes them and make kit-check holds them byte for byte; they are kit's, so the rules of
// this repository skip them.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { errorCode } from '../../tests/errors.mts';
import { readPackage } from '../json/formats.mts';

/** The copies of the @polyspec/kit installed for the checkout `root`, as { copy path: package path }. */
export function kitCopies(root: string): Record<string, string> {
  let manifest: string;
  try {
    manifest = createRequire(join(root, 'package.json')).resolve('@polyspec/kit/package.json');
  } catch (error) {
    throw new Error(`@polyspec/kit is not installed (${errorCode(error) ?? String(error)}); run make install-tools TOOLS=npm, then make install-packages`, { cause: error });
  }
  const copies = readPackage(manifest).kit?.copies;
  if (copies === undefined) throw new Error(`${manifest} declares no kit.copies; install a release of @polyspec/kit`);
  return copies;
}
