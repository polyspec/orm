// The directory of the package that implements a client language: the label of the directory is the package kind (npm for
// TypeScript), as in config/release.json. The PHP extension polyspec_orm (packages/php-ext) implements every PHP library (S10),
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

/**
 * testDirectoryOf is the package directory whose tests check a client language: that of its package, except for the PHP extension,
 * which runs the tests of the PHP library with the extension loaded (S10), since it registers the library's own names.
 */
export function testDirectoryOf(language: string): string {
  return language === 'php-extension' ? packageDirectoryOf('php') : packageDirectoryOf(language);
}
