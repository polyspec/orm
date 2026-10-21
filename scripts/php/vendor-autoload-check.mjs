#!/usr/bin/env node
// Checks that the Composer autoload installed in vendor-php names the files that composer.json declares: the files of
// autoload and autoload-dev. It reports a stale autoload and never repairs it; make orm-install-php installs and
// regenerates it (KSTD-3-2). Usage: node scripts/php/vendor-autoload-check.mjs [<root>], root defaults to the working directory.
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The files that composer.json declares, as paths of the repository root without a leading slash. */
export function declaredFiles(composerJson) {
  const c = JSON.parse(composerJson);
  return new Set([...(c.autoload?.files ?? []), ...(c['autoload-dev']?.files ?? [])].map(f => f.replace(/^\//, '')));
}

/** The files that the installed autoload requires, from its `$baseDir . '/<path>'` entries. */
export function installedFiles(autoloadFiles) {
  return new Set([...autoloadFiles.matchAll(/\$baseDir \. '(\/[^']+)'/g)].map(m => m[1].replace(/^\//, '')));
}

/** The stale and the missing files: an installed file that composer.json does not declare, and a declared file not installed. */
export function differences(composerJson, autoloadFiles) {
  const want = declaredFiles(composerJson);
  const have = installedFiles(autoloadFiles);
  return {
    stale: [...have].filter(f => !want.has(f)),
    missing: [...want].filter(f => !have.has(f)),
  };
}

// Run as a script: report and fail on a difference.
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(process.argv[2] ?? '.');
  const composerJson = readFileSync(path.join(root, 'composer.json'), 'utf8');
  const autoloadFiles = readFileSync(path.join(root, 'vendor-php/composer/autoload_files.php'), 'utf8');
  const { stale, missing } = differences(composerJson, autoloadFiles);
  if (stale.length || missing.length) {
    console.error(`php-vendor-check: vendor-php autoload differs from composer.json; stale: ${JSON.stringify(stale)} missing: ${JSON.stringify(missing)}; run make orm-install-php, which installs and regenerates it`);
    process.exit(1);
  }
}
