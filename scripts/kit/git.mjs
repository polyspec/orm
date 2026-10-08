// Git in a checkout: `git` returns the output and fails with a Stop when git does not end with status 0; `gitResult` returns
// the outcome for a command whose status is an answer, such as `git rev-parse --verify --quiet`.
import { execute, run } from './process.mjs';

/** The standard output of `git <args>` in `root`; Stop with the exit status and the standard error otherwise. */
export const git = (root, ...args) => run('git', args, { cwd: root });

/** The outcome `{ status, stdout, stderr, error }` of `git <args>` in `root`. */
export const gitResult = (root, ...args) => execute('git', args, { cwd: root });
