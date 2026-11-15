// The tools and the gate targets of a job of ci-pipeline.yml (make ci-kit-tools, make ci-kit-gates, T497). The plan of kit
// (make kit-ci-plan, the ci-setup of @polyspec/kit) names, from config/ci.json, the tools that the shared job installs and
// the targets of its gate, and for each runtime the tools and the targets of its job. The recipe of a job reads the plan
// again instead of the outputs of an earlier step, so a local `make ci-kit-shared` or `make ci-kit-runtime RUNTIME=<runtime>`
// runs what CI runs.
//
// Usage: node scripts/check/ci-kit.mts tools|targets shared|runtime [<runtime>]; it prints the words, separated by spaces.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The plan of kit, as make kit-ci-plan prints it when GITHUB_OUTPUT is unset. */
export type KitPlan = { runtimes: { runtime: string; installTools: string[]; targets: string[] }[]; commonTools: string[]; sharedTargets: string[] };

/** words is what the job of `group` (and `runtime`) installs (`tools`) or runs as its gate (`targets`). */
export function words(plan: KitPlan, what: string, group: string, runtime: string | undefined): string[] {
  if (what !== 'tools' && what !== 'targets') throw new Error(`${what} is neither tools nor targets`);
  if (group === 'shared') {
    if (runtime) throw new Error('the shared job takes no runtime');
    return what === 'tools' ? plan.commonTools : ['kit-gates-static', ...plan.sharedTargets];
  }
  if (group !== 'runtime') throw new Error(`${group} is neither shared nor runtime`);
  const job = plan.runtimes.find(entry => entry.runtime === runtime);
  if (!job) throw new Error(`the plan of kit holds no runtime ${runtime ?? '(none)'}; it holds ${plan.runtimes.map(entry => entry.runtime).join(', ')}`);
  return what === 'tools' ? job.installTools : [`kit-gates-runtime-${job.runtime}`, ...job.targets];
}

/** parsePlan reads the plan that make kit-ci-plan printed. */
export function parsePlan(text: string): KitPlan {
  const value: unknown = JSON.parse(text);
  const list = (item: unknown, name: string): string[] => {
    if (!Array.isArray(item) || !item.every(entry => typeof entry === 'string')) throw new Error(`the plan of kit holds no list ${name}: ${text}`);
    return item;
  };
  if (typeof value !== 'object' || value === null || !('runtimes' in value) || !Array.isArray(value.runtimes)) throw new Error(`the plan of kit holds no runtimes: ${text}`);
  const runtimes = value.runtimes.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('runtime' in entry) || typeof entry.runtime !== 'string') throw new Error(`a runtime of the plan of kit has no name: ${text}`);
    return { runtime: entry.runtime, installTools: list('installTools' in entry ? entry.installTools : undefined, 'installTools'), targets: list('targets' in entry ? entry.targets : undefined, 'targets') };
  });
  return { runtimes, commonTools: list('commonTools' in value ? value.commonTools : undefined, 'commonTools'), sharedTargets: list('sharedTargets' in value ? value.sharedTargets : undefined, 'sharedTargets') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [what = '', group = '', runtime] = process.argv.slice(2);
    const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
    // With GITHUB_OUTPUT unset, the plan of kit is printed as JSON.
    const result = spawnSync(process.env.CI_JOB_MAKE || 'make', ['--no-print-directory', '-s', 'kit-ci-plan'], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
    if (result.status !== 0) throw new Error(`make kit-ci-plan ended with ${result.status ?? result.signal}`);
    console.log(words(parsePlan(result.stdout.trim()), what, group, runtime).join(' '));
  } catch (error) {
    console.error(`ci-kit: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
