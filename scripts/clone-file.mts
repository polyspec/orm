// cloneFile copies a file with a copy-on-write clone where the file system has one, so a copy of a large test binary writes almost nothing.
// node's COPYFILE_FICLONE makes a reflink on Linux and no clone on macOS (COPYFILE_FICLONE_FORCE fails there with ENOSYS), so macOS copies with cp -c,
// which calls clonefile(2) and copies where the file system has no clones.
import { spawnSync } from 'node:child_process';
import { constants, copyFileSync } from 'node:fs';

export function cloneFile(from: string, to: string): void {
  if (process.platform !== 'darwin') {
    copyFileSync(from, to, constants.COPYFILE_FICLONE);
    return;
  }
  const copied = spawnSync('/bin/cp', ['-c', from, to], { encoding: 'utf8' });
  if (copied.status !== 0) throw new Error(`cp -c ${from} ${to} exited with ${copied.status ?? copied.signal ?? copied.error}: ${copied.stderr}`);
}
