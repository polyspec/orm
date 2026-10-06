#!/usr/bin/env node
// The GitHub ruleset of the protected branch and the repository settings that the pull request flow needs, declared in
// .github/ruleset.json (G5.91):
//
//   node scripts/github/ruleset.mjs apply --gh <program>   change the declared settings and create or update the ruleset
//                                                          of the declared name where they differ, then compare again
//   node scripts/github/ruleset.mjs check --gh <program>   change nothing; fail when the live settings or ruleset differ
//
// The declaration names the repository, the repository settings (`settings`, fields of PATCH /repos/{owner}/{repo}) and
// the ruleset as the REST API takes it. The ruleset requires a pull request, the merge queue, a linear history and the
// checks of GitHub Actions, so every change reaches the protected branch through a pull request and the merge queue;
// no command of this repository pushes that branch.
//
// `--gh` names the GitHub CLI, authenticated with administration access to the repository; the Makefile passes its
// variable GH. The script reads nothing of the repository but the declaration and imports no module of it.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DECLARATION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.github/ruleset.json');
const USAGE = 'Usage: node scripts/github/ruleset.mjs apply | check --gh <program>';

/** A step failed; the message names its cause. */
class Stop extends Error {}
const log = line => process.stdout.write(`${line}\n`);
const error = line => process.stderr.write(`${line}\n`);

/** JSON with the keys of every object sorted, so two values compare by content. */
function canonical(value) {
  const sorted = entry => {
    if (Array.isArray(entry)) return entry.map(sorted);
    if (entry !== null && typeof entry === 'object') return Object.fromEntries(Object.keys(entry).sort().map(key => [key, sorted(entry[key])]));
    return entry;
  };
  return JSON.stringify(sorted(value) ?? null);
}

const byCanonical = (a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);

/** Runs a program: { status, stdout, stderr }. */
async function run(program, args, { input } = {}) {
  const child = spawn(program, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk));
  if (input !== undefined) child.stdin.end(input);
  const status = await new Promise((resolve, reject) => {
    child.on('error', cause => reject(new Stop(`${program} ${args[0]} could not start: ${cause.message}`)));
    child.on('close', code => resolve(code ?? 1));
  });
  return { status, stdout, stderr };
}

/** `gh api` as a function: { status, body }; never fails for an HTTP status. */
function githubApi(gh, run) {
  return async (method, apiPath, body) => {
    const args = ['api', '--method', method, '--include', apiPath, ...(body === undefined ? [] : ['--input', '-'])];
    const result = await run(gh, args, { input: body === undefined ? undefined : JSON.stringify(body) });
    // gh exits with 1 for an HTTP error status; the status line is still on standard output.
    const found = /^HTTP\/[\d.]+ (\d{3})/.exec(result.stdout);
    if (!found) throw new Stop(`gh api ${method} ${apiPath} failed: ${result.stderr.trim() || `exit status ${result.status}`}`);
    const text = result.stdout.split(/\r?\n\r?\n/).slice(1).join('\n\n').trim();
    return { status: Number(found[1]), body: text ? JSON.parse(text) : null };
  };
}

async function expectOk(api, method, apiPath, body) {
  const answer = await api(method, apiPath, body);
  if (answer.status >= 300) throw new Stop(`${method} ${apiPath} answered ${answer.status}: ${canonical(answer.body)}`);
  return answer.body;
}

/**
 * The fields of a ruleset that the declaration sets, in an order-free form: rules sorted, the required checks and the
 * bypass actors sorted. Fields that GitHub adds (id, source, _links, timestamps) are not compared.
 */
function normalize(ruleset, keys) {
  const picked = Object.fromEntries(keys.map(key => [key, ruleset?.[key] ?? null]));
  if (Array.isArray(picked.bypass_actors)) picked.bypass_actors = [...picked.bypass_actors].sort(byCanonical);
  if (Array.isArray(picked.rules)) {
    picked.rules = picked.rules
      .map(rule => {
        const checks = rule.parameters?.required_status_checks;
        return Array.isArray(checks) ? { ...rule, parameters: { ...rule.parameters, required_status_checks: [...checks].sort(byCanonical) } } : rule;
      })
      .sort(byCanonical);
  }
  return picked;
}

/** The fields of the declared ruleset whose live value differs: [[field, actual, wanted]], empty when they match. */
function differences(declared, live) {
  const keys = Object.keys(declared);
  const wanted = normalize(declared, keys);
  const actual = normalize(live, keys);
  return keys.filter(key => canonical(actual[key]) !== canonical(wanted[key])).map(key => [key, actual[key], wanted[key]]);
}

/** The live ruleset of the declared name, or null; fails when the name is not unique. */
async function liveRuleset(declaration, api) {
  const repo = `repos/${declaration.repository}`;
  const { name } = declaration.ruleset;
  const listed = (await expectOk(api, 'GET', `${repo}/rulesets?includes_parents=false&per_page=100`)) ?? [];
  const named = listed.filter(ruleset => ruleset.name === name);
  if (named.length > 1) {
    throw new Stop(`${declaration.repository} has ${named.length} rulesets named ${name} (ids ${named.map(ruleset => ruleset.id).join(', ')}); delete all but one`);
  }
  return named.length === 1 ? expectOk(api, 'GET', `${repo}/rulesets/${named[0].id}`) : null;
}

/** The declared repository settings whose live value differs: [[field, actual, wanted]]. */
async function settingChanges(declaration, api) {
  const settings = declaration.settings ?? {};
  if (Object.keys(settings).length === 0) return [];
  const repository = await expectOk(api, 'GET', `repos/${declaration.repository}`);
  return Object.keys(settings).filter(key => canonical(repository?.[key] ?? null) !== canonical(settings[key])).map(key => [`settings.${key}`, repository?.[key] ?? null, settings[key]]);
}

/** Compares the declaration with the live settings and ruleset: { live, changes }. Reads only. */
async function plan(declaration, api) {
  const settings = await settingChanges(declaration, api);
  const live = await liveRuleset(declaration, api);
  if (live === null) return { live, settings, changes: [...settings, ['ruleset', null, declaration.ruleset.name]] };
  return { live, settings, changes: [...settings, ...differences(declaration.ruleset, live)] };
}

/** Changes the declared settings and creates or updates the ruleset where they differ, then compares again. */
async function apply(declaration, api) {
  const repo = `repos/${declaration.repository}`;
  const { live, settings, changes } = await plan(declaration, api);
  for (const [field, actual, wanted] of changes) log(`[ruleset] ${field}: ${canonical(actual)} -> ${canonical(wanted)}`);
  if (settings.length > 0) await expectOk(api, 'PATCH', repo, declaration.settings);
  const rulesetChanged = changes.length > settings.length;
  if (live === null) await expectOk(api, 'POST', `${repo}/rulesets`, declaration.ruleset);
  else if (rulesetChanged) await expectOk(api, 'PUT', `${repo}/rulesets/${live.id}`, declaration.ruleset);
  const remaining = (await plan(declaration, api)).changes;
  if (remaining.length > 0) throw new Stop(`the repository still differs after applying: ${remaining.map(([field]) => field).join(', ')}`);
  return changes;
}

async function main(argv) {
  const mode = argv[0];
  const ghAt = argv.indexOf('--gh');
  const gh = ghAt > 0 ? argv[ghAt + 1] : undefined;
  if (argv.length !== 3 || !['apply', 'check'].includes(mode) || ghAt !== 1 || !gh) {
    error(USAGE);
    return 2;
  }
  let declaration;
  try {
    declaration = JSON.parse(readFileSync(DECLARATION, 'utf8'));
  } catch (cause) {
    error(`[ruleset] ${cause.message}`);
    return 1;
  }
  const api = githubApi(gh, run);
  const name = `${declaration.repository} ruleset ${declaration.ruleset.name}`;
  let changes;
  try {
    if (mode === 'apply') {
      changes = await apply(declaration, api);
      log(`[ruleset] ${name}: ${changes.length} field(s) changed; the ruleset matches .github/ruleset.json`);
      return 0;
    }
    ({ changes } = await plan(declaration, api));
  } catch (cause) {
    if (!(cause instanceof Stop)) throw cause;
    error(`[ruleset] ${cause.message}`);
    return 1;
  }
  for (const [field, actual, wanted] of changes) error(`[ruleset] differs: ${field}: live ${canonical(actual)}, declared ${canonical(wanted)}`);
  if (changes.length > 0) {
    error(`[ruleset] ${name} differs from .github/ruleset.json; run make github-ruleset`);
    return 1;
  }
  log(`[ruleset] ${name}: the ruleset matches .github/ruleset.json`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
