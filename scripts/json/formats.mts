// The ecosystem files that orm's scripts read: npm and Composer manifests, locks and installed lists. Each is read against
// a schema of the fields the scripts use (schema/); the tool that writes the file owns its other fields, which the schemas
// leave open.
import { parseJson, readJsonFile } from './schema.mts';

const schema = (name: string): string => new URL(`./schema/${name}.schema.json`, import.meta.url).pathname;

/** The fields of package.json that the scripts read. */
export type PackageManifest = {
  name?: string; version?: string; bin?: string | Record<string, string>; scripts?: Record<string, string>; engines?: Record<string, string>;
  dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>; overrides?: Record<string, unknown>; kit?: { copies?: Record<string, string> };
};
/** The fields of an npm lock that the scripts read. */
export type NpmLock = { lockfileVersion?: 3; packages: Record<string, { version?: string; optional?: boolean; link?: boolean; resolved?: string }> };
/** The fields of composer.json that the scripts read. */
export type ComposerManifest = { name?: string; version?: string; require?: Record<string, string>; 'require-dev'?: Record<string, string>; config?: { 'vendor-dir'?: string } };
/** The fields of composer.lock or vendor/composer/installed.json that the scripts read. */
export type ComposerPackages = { packages: { name: string; version: string }[]; 'packages-dev'?: { name: string; version: string }[] };

/** readPackage reads a package.json. */
export const readPackage = (file: string): PackageManifest => readJsonFile<PackageManifest>(file, schema('package'));
/** parsePackage reads the text of a package.json; source names it in the errors. */
export const parsePackage = (text: string, source: string): PackageManifest => parseJson<PackageManifest>(text, schema('package'), source);
/** readNpmLock reads a package-lock.json or a node_modules/.package-lock.json. */
export const readNpmLock = (file: string): NpmLock => readJsonFile<NpmLock>(file, schema('npm-lock'));
/** parseNpmLock reads the text of an npm lock; source names it in the errors. */
export const parseNpmLock = (text: string, source: string): NpmLock => parseJson<NpmLock>(text, schema('npm-lock'), source);
/** readComposer reads a composer.json. */
export const readComposer = (file: string): ComposerManifest => readJsonFile<ComposerManifest>(file, schema('composer'));
/** parseComposer reads the text of a composer.json; source names it in the errors. */
export const parseComposer = (text: string, source: string): ComposerManifest => parseJson<ComposerManifest>(text, schema('composer'), source);
/** readComposerPackages reads a composer.lock or a vendor/composer/installed.json. */
export const readComposerPackages = (file: string): ComposerPackages => readJsonFile<ComposerPackages>(file, schema('composer-lock'));

/** One event of go test -json. */
export type GoTestEvent = {
  Time?: string; Action: 'start' | 'run' | 'pause' | 'cont' | 'pass' | 'bench' | 'fail' | 'output' | 'skip' | 'build-output' | 'build-fail';
  Package?: string; ImportPath?: string; Test?: string; Elapsed?: number; Output?: string; FailedBuild?: string;
};
/** parseGoTestEvent reads one line of go test -json; source names it in the errors. */
export const parseGoTestEvent = (line: string, source: string): GoTestEvent => parseJson<GoTestEvent>(line, schema('go-test-event'), source);

/** One JSON message of cargo. */
export type CargoMessage = {
  reason: string; executable?: string | null; manifest_path?: string; profile?: { test?: boolean }; target?: { name?: string; kind?: string[] };
};
/** parseCargoMessage reads one line of cargo --message-format=json; source names it in the errors. */
export const parseCargoMessage = (line: string, source: string): CargoMessage => parseJson<CargoMessage>(line, schema('cargo-message'), source);

/** One package of npm pack --json. */
export type NpmPack = { name: string; version: string; files: { path: string }[] };
/** parseNpmPack reads the output of npm pack --json, an array or an object by package name, as its packages. */
export function parseNpmPack(text: string, source: string): NpmPack[] {
  const packs = parseJson<NpmPack[] | Record<string, NpmPack>>(text, schema('npm-pack'), source);
  return Array.isArray(packs) ? packs : Object.values(packs);
}
