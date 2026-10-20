// The directory of the package that implements a client language: the label of the directory is the package kind (npm for
// TypeScript), as in config/release.json. The PHP extension orm_dbspec (packages/php-ext) implements every PHP library (S10),
// so php-extension is a client language of its own.
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
