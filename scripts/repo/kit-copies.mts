// The copies of @polyspec/kit in this checkout: kit.copies of the package.json of the installed package maps each copy to its
// file in the package. make kit-sync writes them and make kit-check holds them byte for byte; they are kit's, so the rules of
// this repository skip them.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { errorCode } from '../../tests/errors.mts';
import { readPackage } from '../json/formats.mts';

/** The copies of the @polyspec/kit installed for the checkout `root`, as { copy path: package path }. */
export function kitCopies(root: string): Record<string, string> {
  const { path, manifest } = kitPackage(root);
  const copies = manifest.kit?.copies;
  if (copies === undefined) throw new Error(`${path} declares no kit.copies; install a release of @polyspec/kit`);
  return copies;
}

/** Paths owned by Kit in the checkout, including files that are no longer generated copies. */
export function kitOwnedPaths(root: string): string[] {
  const { manifest } = kitPackage(root);
  const kit: unknown = manifest.kit;
  const owners = isRecord(kit) ? kit.owners : undefined;
  if (!Array.isArray(owners)) throw new Error('@polyspec/kit package.json declares no kit.owners');
  const ownerValues: unknown[] = owners;
  return ownerValues.flatMap(owner => {
    if (!isRecord(owner) || !Array.isArray(owner.paths)) return [];
    return owner.paths.filter((path): path is string => typeof path === 'string');
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function kitPackage(root: string): { path: string; manifest: ReturnType<typeof readPackage> } {
  let manifest: string;
  try {
    manifest = createRequire(join(root, 'package.json')).resolve('@polyspec/kit/package.json');
  } catch (error) {
    throw new Error(`@polyspec/kit is not installed (${errorCode(error) ?? String(error)}); run make install-tools TOOLS=npm, then make install-packages`, { cause: error });
  }
  return { path: manifest, manifest: readPackage(manifest) };
}
