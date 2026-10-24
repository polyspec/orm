import { linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Writes a dbspec set-files fixture tree under a fresh temporary directory. */
export function buildSetTree(tree, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix)).replaceAll('\\', '/');
  try {
    for (const [path, entry] of Object.entries(tree)) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      if ('file' in entry) writeFileSync(target, entry.file, 'utf8');
      else if ('hex' in entry) writeFileSync(target, Buffer.from(entry.hex, 'hex'));
      else if ('hardlink' in entry) linkSync(join(root, entry.hardlink), target);
      else {
        // Windows needs the kind of the target; POSIX ignores it.
        let type = 'file';
        try { if (statSync(join(dirname(target), entry.symlink)).isDirectory()) type = 'dir'; } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          // A missing target is a file link.
        }
        symlinkSync(entry.symlink, target, type);
      }
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return root;
}
