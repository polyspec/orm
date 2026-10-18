// Development Node version check. The Node that runs the checks and the build is the one version the tool node in `mise.toml` declares once
// (kit K171), which make install-tools installs into var/tools, and which the local checks and every workflow run with.
// engines.node (">=x.y.z") in package.json is the lowest version the TypeScript client supports; make
// ts-min-check runs it.

import semver from 'semver';
import { parse as parseToml } from 'smol-toml';
import { actionSteps, workflowSteps } from './workflow.mts';
import { parseNpmLock, parsePackage } from '../json/formats.mts';

// exactVersion is that version if it is an exact x.y.z, and null otherwise. The comparison is done by semver.
const exactVersion = (text: string): string | null => /^\d+\.\d+\.\d+$/.test(text) ? text : null;

// miseNode is the `[tools]` node of mise.toml if it is a string, and '' otherwise.
const miseNode = (miseToml: string): string => {
  const tools: unknown = parseToml(miseToml)['tools'];
  const node = typeof tools === 'object' && tools !== null && 'node' in tools ? tools.node : undefined;
  return typeof node === 'string' ? node : '';
};

// nodeVersionErrors returns one error at each place where the Node version declaration is not one, or differs from the running Node;
// it returns one error.
//   - declared (the tool node in the content of miseToml, `mise.toml`) is one exact x.y.z.
//   - minimum (">=x.y.z" in package.json engines.node) is not higher than declared.
//   - The actions/setup-node step of the workflows ({path: text}) reads the version with `node-version-file: mise.toml`
//     and does not write `node-version` directly. A workflow that uses Node uses setup-node.
//   - running (process.versions.node) is the same as declared.
export function nodeVersionErrors(miseToml: string, minimum: string | undefined, workflows: Record<string, string>, running: string): string[] {
  const errors: string[] = [];
  const declared = miseNode(miseToml);
  const exact = exactVersion(declared);
  if (!exact)
    errors.push(`mise.toml must declare the tool node with one exact version x.y.z, found ${JSON.stringify(declared)}`);
  const lowest = exactVersion(/^>=(\d+\.\d+\.\d+)$/.exec(minimum ?? '')?.[1] ?? '');
  if (!lowest) errors.push(`package.json engines.node must be ">=x.y.z", found ${JSON.stringify(minimum)}`);
  if (exact && lowest && semver.lt(exact, lowest))
    errors.push(`mise.toml node ${exact} is below package.json engines.node ${minimum}`);
  for (const [path, workflow] of Object.entries(workflows)) {
    const steps = actionSteps(workflow, 'actions/setup-node');
    const usesNode = workflowSteps(workflow).some(step => /(^|[\s;&|(])(node|npm|npx)\s/m.test(step.run));
    if (usesNode && steps.length === 0) errors.push(`${path} runs Node without actions/setup-node`);
    for (const step of steps) {
      if (Object.hasOwn(step.with, 'node-version')) errors.push(`${path} declares node-version itself; mise.toml declares it`);
      if (step.with['node-version-file'] !== 'mise.toml')
        errors.push(`${path} does not read node-version-file mise.toml in actions/setup-node`);
    }
  }
  if (exact && running !== exact)
    errors.push(`Node ${running} runs the checks; mise.toml declares ${exact}; run make install-tools TOOLS=npm, which installs it into var/tools`);
  return errors;
}

// Check of npm git sources. polyspec packages are fetched from the release archive URL of a GitHub tag, and npm
// also installs with `npm ci`, which cannot use git, so no package may be fetched from git.
const GIT_SOURCE = /^(?:git\+|git:|ssh:|github:)/;
// GITHUB_SHORTHAND is the `owner/repo` or `owner/repo#ref` spec that npm reads as a GitHub repository.
const GITHUB_SHORTHAND = /^[^@\s/:.][^\s/:]*\/[^\s/:]+$/;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

// npmGitSourceErrors, over files ({path: text}: the tracked package.json and package-lock.json), returns
// one error for each dependency fetched from git.
//   - A dependency spec in package.json does not start with `git+`, `git:`, `ssh:` or `github:`, and is not a GitHub
//     shorthand (`owner/repo#ref`).
//   - No `resolved` in package-lock.json starts with `git+`, `git:`, `ssh:` or `github:`.
export function npmGitSourceErrors(files: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (/(?:^|\/)package\.json$/.test(path)) {
      const manifest = parsePackage(text, path);
      for (const field of DEPENDENCY_FIELDS)
        for (const [name, spec] of Object.entries(manifest[field] ?? {}))
          if (GIT_SOURCE.test(spec) || GITHUB_SHORTHAND.test(spec))
            errors.push(`${path} ${field} ${name} is ${spec}, a git source; use the release archive URL of the GitHub tag`);
    } else if (/(?:^|\/)package-lock\.json$/.test(path)) {
      for (const [entry, record] of Object.entries(parseNpmLock(text, path).packages))
        if (record.resolved !== undefined && GIT_SOURCE.test(record.resolved))
          errors.push(`${path} resolves ${entry} from ${record.resolved}, a git source; use the release archive URL of the GitHub tag`);
    }
  }
  return errors;
}
