// The plan of the CI group jobs of ci.yml (make ci-plan, T497). The `uses:` steps of a group job run before its one run step,
// so what they need is known before the job starts: the plan job writes, for each CI group, whether the group sets up PHP
// (setup-php) and Rust (rust-cache), from the needs that the targets of the group declare (groupOutputs of
// scripts/check/ci-setup.mts). The output groups is the matrix include of the job test, and preflight that of the job
// preflight, which every other job needs (T428).
//
// Usage: node scripts/check/ci-plan.mts <group>=<target>,<target>... ; make ci-plan passes every group of CI_GROUPS.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupOutputs, type Needs } from './ci-setup.mts';
import { declaredNeeds } from './inputs.mts';

/** One entry of the matrix include of a group job. */
export type GroupEntry = { group: string; php: boolean; rust: boolean };

/** The group of the job preflight. */
export const PREFLIGHT = 'preflight';

/** planLines are the output lines `groups=<json>` and `preflight=<json>` of the groups {group: [target]}. */
export function planLines(groups: Record<string, string[]>, needs: Needs): string[] {
  const entries: GroupEntry[] = Object.entries(groups).map(([group, targets]) => {
    const outputs = groupOutputs(targets, needs);
    return { group, php: outputs['php'] === true, rust: outputs['rust'] === true };
  });
  if (!entries.some(entry => entry.group === PREFLIGHT)) throw new Error(`the CI groups hold no group ${PREFLIGHT}, whose job every other job needs`);
  return [
    `groups=${JSON.stringify(entries.filter(entry => entry.group !== PREFLIGHT))}`,
    `preflight=${JSON.stringify(entries.filter(entry => entry.group === PREFLIGHT))}`,
  ];
}

/** parseGroups reads the arguments `<group>=<target>,<target>...`. */
export function parseGroups(args: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const arg of args) {
    const match = /^([a-z0-9_]+)=(\S+)$/.exec(arg);
    if (!match?.[1] || !match[2]) throw new Error(`${arg} is no <group>=<target>,<target>...; make ci-plan passes every group of CI_GROUPS with its CI_TARGETS_<group>`);
    if (Object.hasOwn(groups, match[1])) throw new Error(`the group ${match[1]} is given twice`);
    groups[match[1]] = match[2].split(',').filter(Boolean);
  }
  if (Object.keys(groups).length === 0) throw new Error('give the CI groups: node scripts/check/ci-plan.mts <group>=<target>,<target>...');
  return groups;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
    for (const line of planLines(parseGroups(process.argv.slice(2)), declaredNeeds(root))) console.log(line);
  } catch (error) {
    console.error(`ci-plan: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
