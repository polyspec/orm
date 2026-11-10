// The size check of the diff of a push (make diff-size-check, T418). GitHub evaluates the paths-ignore of ci.yml over the
// first 3000 files of the diff of a push; past that a run may not start although a path it does not ignore changed. The
// documents workflow runs this check on every push that ci.yml filters, so such a push fails here and names the way to run
// ci.yml, never passes unchecked. The diff of a push of an existing branch is the two-dot diff of its before and after
// commits, the one that GitHub compares; a push that creates its branch has no before commit, so the check fails and names it.
// A manual run has no path filter and nothing to count. git diff --name-only --no-renames counts the files, a rename as its two
// paths, so the count is never below GitHub's. The event is the one that GitHub writes to GITHUB_EVENT_PATH for GITHUB_EVENT_NAME.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The number of files of a diff beyond which GitHub does not evaluate the path filter of a workflow. */
export const LIMIT = 3000;

/** The diff of an event: the git revision range that GitHub compares, or none, with the reason. */
export type Diff = { range: string } | { none: string };

/** The string at `keys` of the event payload `payload`, or an error that names the missing field. */
function field(payload: unknown, keys: string[]): string {
  let value: unknown = payload;
  for (const key of keys) value = typeof value === 'object' && value !== null ? Object.entries(value).find(([name]) => name === key)?.[1] : undefined;
  if (typeof value !== 'string' || value === '') throw new Error(`the event has no ${keys.join('.')}`);
  return value;
}

/** The diff that GitHub compares for the event `name` with the payload `payload`; an event that ci.yml does not filter is an error. */
export function diffOf(name: string, payload: unknown): Diff {
  if (name === 'workflow_dispatch') return { none: 'a manual run has no path filter: ci.yml runs every job' };
  if (name !== 'push') throw new Error(`the event ${name} is none that ci.yml filters by its paths`);
  const before = field(payload, ['before']);
  const after = field(payload, ['after']);
  if (/^0+$/.test(before)) throw new Error(`the push creates ${field(payload, ['ref'])}, which has no before commit to compare; run ci.yml with gh workflow run ci.yml --ref <branch>`);
  return { range: `${before}..${after}` };
}

/** The number of files that the diff `range` changes in the Git checkout `root`. */
export function changedFiles(root: string, range: string): number {
  const out = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', range, '--'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  return out.split('\0').filter(Boolean).length;
}

/** The failure for `count` files of the diff `range`, or undefined while GitHub evaluates the path filter over all of them. */
export function judge(range: string, count: number): string | undefined {
  if (count <= LIMIT) return undefined;
  return `${range} changes ${count} files, more than the ${LIMIT} over which GitHub evaluates the paths-ignore of ci.yml, so ci.yml may not have started; run it with gh workflow run ci.yml --ref <branch>`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = process.env['GITHUB_EVENT_NAME'];
  const file = process.env['GITHUB_EVENT_PATH'];
  if (!name || !file) {
    console.error('diff-size-check: GITHUB_EVENT_NAME and GITHUB_EVENT_PATH name the event; the documents workflow sets them');
    process.exit(2);
  }
  try {
    const diff = diffOf(name, JSON.parse(readFileSync(file, 'utf8')));
    if ('none' in diff) {
      console.log(`diff-size-check: ${name}: ${diff.none}`);
    } else {
      const count = changedFiles(process.cwd(), diff.range);
      const failure = judge(diff.range, count);
      if (failure) {
        console.error(`diff-size-check: ${name}: ${failure}`);
        process.exit(1);
      }
      console.log(`diff-size-check: ${name}: ${diff.range} changes ${count} files, within the ${LIMIT} of GitHub's path filter`);
    }
  } catch (error) {
    console.error(`diff-size-check: ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
