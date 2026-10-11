#!/usr/bin/env node
// The push gate. A push happens only when no item of a tracker of config/checklist.json is in its active state (for a
// checklist, `[~]`, in progress): work in progress does not reach the remote. Items in the other states (waiting, done,
// bypassed) do not block a push.
//
//   node scripts/kit/push-gate.mjs hook          the pre-push hook .githooks/pre-push: reads the lines
//                                                `<local ref> <local sha> <remote ref> <remote sha>` of Git on standard
//                                                input and refuses the push while a tracker of a pushed commit or of the
//                                                working tree has an item in the active state, or cannot be read, and refuses it while a commit that the push sends has a
//                                                finding of the commit check (check-commits.mjs, config/commits.json, as make commits-check)
//   node scripts/kit/push-gate.mjs commit <rev>  the check of a pushed commit, for a push from a checkout without the
//                                                hook: fails for the same reasons and when the commit does not track a
//                                                hook of config/checklist.json with mode 100755; prints each line also as
//                                                a GitHub annotation and appends it to $GITHUB_STEP_SUMMARY when it is set
//
// The refusal names each item with its file and ID and the place where it was found: the pushed ref and commit or the
// working tree. A tracker whose translation lists other IDs or states than the document is unreadable for the gate.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { blockingSentence, inspectTrackers, loadConfig } from './checklist.mjs';
import { HOOKS_PATH } from './git-hooks.mjs';
import { isMain, ROOT } from './paths.mjs';
import { git, gitResult } from './git.mjs';
import { findingLines, loadCommitRules, logMessages } from './check-commits.mjs';

const USAGE = 'Usage: node scripts/kit/push-gate.mjs hook | commit <rev>';
const NO_OBJECT = /^0+$/;
const SHORT = 12;

const RULE = 'A push happens only when no item of a tracker is in its active state; work in progress does not reach the remote.';
const COMMIT_FIX = 'Amend each listed commit that the remote does not hold yet, then push again; this gate does not rewrite a pushed commit.';
const FIX = 'Finish each listed item in a commit with its documentation and tests, or move it to a state that does not block, such as bypassed with its cause and retry condition; then push again.';

/**
 * Inspects the trackers of `sources`, each `{ where, read }` where `read(file)` returns the text of a file or throws why it
 * cannot. Returns the lines of the refusal, or an empty array when no item is in an active state.
 */
export function inspect(config, sources) {
  const active = [];
  const unreadable = [];
  for (const { where, read } of sources) {
    const found = inspectTrackers(config, read);
    for (const item of found.active) active.push(`  ${where}: ${item.file} ${item.id} ${item.title}`);
    for (const problem of found.problems) unreadable.push(`  ${where}: ${problem}`);
  }
  const lines = [];
  if (unreadable.length > 0) lines.push('push refused: the push gate cannot read the trackers (config/checklist.json)', ...unreadable, 'The gate refuses a push whose trackers it cannot read; fix the cause and push again.');
  if (active.length > 0) lines.push(`push refused: ${active.length} item${active.length === 1 ? ' is' : 's are'} in the active state (${blockingSentence(config)})`, ...active, RULE, FIX);
  return lines;
}

// The reader of the files of a commit, which names the commit and the file that it lacks.
const committed = (root, sha) => (file) => {
  const shown = gitResult(root, 'show', `${sha}:${file}`);
  if (shown.error) throw shown.error;
  if (shown.status !== 0) throw new Error(`the commit has no ${file}: ${shown.stderr.trim()}`);
  return shown.stdout;
};

const working = root => (file) => {
  if (!existsSync(path.join(root, file))) throw new Error(`${file} does not exist in the working tree`);
  return readFileSync(path.join(root, file), 'utf8');
};

/**
 * The finding lines of the commits that a push of `localSha` to a ref at `remoteSha` sends. A new ref (zero remote sha) sends
 * the commits that no remote ref holds; an update sends the commits after the remote sha.
 */
function pushedFindings(root, localSha, remoteSha, rules) {
  if (NO_OBJECT.test(remoteSha)) return findingLines(root, logMessages(root, [localSha, '--not', '--remotes'], `${localSha} without the remote refs`), rules);
  return findingLines(root, logMessages(root, [`${remoteSha}..${localSha}`], `${remoteSha}..${localSha}`), rules);
}

/** The refusal lines of the commit findings of a push, empty when there is none. */
function commitRefusal(findings) {
  if (findings.length === 0) return [];
  return [`push refused: ${findings.length} commit finding${findings.length === 1 ? '' : 's'} (config/commits.json)`, ...findings.map(finding => `  ${finding}`), COMMIT_FIX];
}

/** The refusal lines of a push: `input` holds the lines that Git passes to the pre-push hook. */
export function hook(root, input) {
  const config = loadConfig(root);
  const rules = loadCommitRules(root);
  const sources = [];
  const findings = [];
  for (const line of input.split('\n').filter(entry => entry.trim())) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) throw new Error(`the pre-push input line ${JSON.stringify(line)} is not "<local ref> <local sha> <remote ref> <remote sha>"`);
    const [localRef, localSha, , remoteSha] = fields;
    // A deleted ref pushes no commit.
    if (NO_OBJECT.test(localSha)) continue;
    sources.push({ where: `${localRef} ${localSha.slice(0, SHORT)}`, read: committed(root, localSha) });
    findings.push(...pushedFindings(root, localSha, remoteSha, rules));
  }
  sources.push({ where: 'working tree', read: working(root) });
  return [...inspect(config, sources), ...commitRefusal(findings)];
}

/** The failure lines of the commit `rev`, or an empty array, with the commit that `rev` names. */
export function commit(root, rev) {
  const config = loadConfig(root);
  const resolved = gitResult(root, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`);
  if (resolved.status !== 0) return { sha: rev, lines: [`push refused: ${rev} is not a commit of this repository`] };
  const sha = resolved.stdout.trim();
  const lines = inspect(config, [{ where: `commit ${sha.slice(0, SHORT)}`, read: committed(root, sha) }]);
  for (const name of config.hooks) {
    const file = `${HOOKS_PATH}/${name}`;
    const entry = git(root, 'ls-tree', sha, '--', file).trim();
    if (!entry) lines.push(`push refused: ${file} is not tracked in commit ${sha.slice(0, SHORT)}, so a checkout of it has no ${name} hook; restore the hook`);
    else if (!entry.startsWith('100755 ')) lines.push(`push refused: ${file} is tracked with mode ${entry.split(' ')[0]}, not 100755, in commit ${sha.slice(0, SHORT)}, so Git does not run it; restore its mode with git update-index --chmod=+x ${file}`);
  }
  return { sha, lines };
}

// A GitHub annotation holds the message on one line; % and the line breaks are escaped as GitHub requires.
const annotation = line => `::error::${line.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`;

if (isMain(import.meta.url)) {
  const root = ROOT;
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'hook' && args.length === 0) {
    let lines;
    try {
      lines = hook(root, readFileSync(0, 'utf8'));
    } catch (error) {
      // A gate that cannot decide does not allow the push.
      lines = [`push refused: the push gate failed: ${error.message}`];
    }
    for (const line of lines) console.error(line);
    process.exitCode = lines.length > 0 ? 1 : 0;
  } else if (mode === 'commit' && args.length === 1) {
    let result;
    try {
      result = commit(root, args[0]);
    } catch (error) {
      result = { sha: args[0], lines: [`push refused: the push gate failed: ${error.message}`] };
    }
    for (const line of result.lines) {
      console.error(line);
      console.log(annotation(line));
    }
    if (result.lines.length > 0 && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Push gate\n\n\`\`\`\n${result.lines.join('\n')}\n\`\`\`\n`);
    if (result.lines.length === 0) console.log(`[push-gate] commit ${result.sha.slice(0, SHORT)}: no item is in an active state and every hook of config/checklist.json is tracked with mode 100755`);
    process.exitCode = result.lines.length > 0 ? 1 : 0;
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
}
