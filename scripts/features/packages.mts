// The directory of the package that implements a client language: the label of the directory is the package kind (npm for
// TypeScript), as in config/release.json. PHP extension is a client language with its own tests under packages/php-ext.
export const packageDirectory = {
  go: 'packages/go',
  php: 'packages/php',
  'php-extension': 'packages/php-ext',
  python: 'packages/python',
  rust: 'packages/rust',
  typescript: 'packages/ts',
};

/** packageDirectoryOf is the package directory of a client language; a language that has no package throws. */
export function packageDirectoryOf(language: string): string {
  const directory = new Map<string, string>(Object.entries(packageDirectory)).get(language);
  if (directory === undefined) throw new Error(`no package implements the client language ${language}`);
  return directory;
}

/** testDirectoryOf is the owning package directory whose tests check a client language. */
export function testDirectoryOf(language: string): string {
  return packageDirectoryOf(language);
}
