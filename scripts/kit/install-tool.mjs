// The install step that the tools of var/tools share: build a release into a temporary directory beside the target, check
// the release there and rename it into place, so a reader never sees a partly installed tool and a second run with the
// recorded release installs nothing.
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Installs `label` at `recorded` into `prefix` unless `installedRelease(prefix)` already prints it. `install(next)` builds
 * the tool into the temporary directory `next`. Returns `{ installed, release }`; throws with the expected and the actual
 * release when the build does not print `recorded`.
 */
export function installOnce({ root, label, prefix, recorded, installedRelease, install, print = () => {} }) {
  const found = installedRelease(prefix);
  const where = path.relative(root, prefix);
  if (found === recorded) {
    print(`${label}: ${recorded} is installed in ${where}`);
    return { installed: false, release: recorded };
  }
  print(`${label}: ${found ? `${found} is installed` : 'none is installed'} in ${where}; installing ${recorded}`);
  mkdirSync(path.dirname(prefix), { recursive: true });
  const next = mkdtempSync(`${prefix}.next-`);
  try {
    install(next);
    const release = installedRelease(next);
    if (release !== recorded) throw new Error(`the installation of ${label} ${recorded} into ${next} prints ${release}; expected ${recorded}`);
    // The old installation moves aside with one rename and the new one takes its place with another.
    const old = `${prefix}.old-${process.pid}`;
    if (existsSync(prefix)) renameSync(prefix, old);
    renameSync(next, prefix);
    rmSync(old, { recursive: true, force: true });
    print(`${label}: installed ${recorded} in ${where}`);
    return { installed: true, release: recorded };
  } finally {
    rmSync(next, { recursive: true, force: true });
  }
}
