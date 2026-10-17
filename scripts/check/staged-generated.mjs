// The staged-file check of AGENTS.md "Generated files": a staged path that a covered pattern matches is refused unless it
// is a named exception. The pure function `generatedOffenders` takes the paths; `main` reads the index of the checkout.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const covered = [
  /(^|\/)(node_modules|vendor|vendor-php|\.venv|venv)\//,
  /(^|\/)(dist|target)\//,
  /(^|\/)[^/]*\.egg-info\//,
  /\.vsix$/,
  /(^|\/)__pycache__\//,
  /\.pyc$/,
  /(^|\/)\.vitepress\/cache\//,
  /(^|\/)\.runtime\//,
  /(^|\/)var\//,
  /\.test$/,
];

// The deliberate exceptions, named in AGENTS.md "Generated files".
const exceptions = [/^\.kit\/kit\.lock\.json$/, /^tests\/[^/]+\/fixtures\//];

/** Returns the paths that a covered pattern matches and that no named exception allows. */
export function generatedOffenders(paths) {
  return paths.filter(p => covered.some(re => re.test(p)) && !exceptions.some(re => re.test(p)));
}

export function stagedPaths(cwd = process.cwd()) {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd }).toString();
  return out.split('\0').filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const offenders = generatedOffenders(stagedPaths());
  for (const p of offenders) console.error(`staged-check: ${p} is a generated file (AGENTS.md "Generated files"); unstage it`);
  if (offenders.length > 0) process.exit(1);
  console.log('staged-check: no generated file is staged');
}
