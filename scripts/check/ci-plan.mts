// Preview CI declarations without invoking Make, installers, databases or native test tools.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ciCheckTargetErrors, ciGroups } from '../repo/ci.mts';
import { makeTargets } from '../repo/testcases.mts';
import { readWorkflow } from '../repo/workflow.mts';
import { groupOutputs, STEP_OUTPUT, stepCondition, type Needs } from './ci-setup.mts';
import { declaredNeeds } from './inputs.mts';

/** Read the declared orchestration; expressions remain source text, never execution. */
export function ciDeclarationPlan(makefile: string, workflow: string, needs: Needs) {
  const errors = ciCheckTargetErrors(workflow, makefile);
  if (errors.length) throw new Error(`CI declarations disagree: ${errors.join('; ')}; fix the workflow and CI_TARGETS declarations`);
  const { groups, targets } = ciGroups(makefile);
  const source = readWorkflow(workflow);
  const test = source.jobs.find(job => job.id === 'test');
  if (!test) throw new Error('CI has no test job; declare the CI group matrix in .github/workflows/ci.yml');
  const check = test.steps.findIndex(step => step.run.includes('make check-run GROUP='));
  if (check < 0) throw new Error('CI test job has no group execution step; declare make check-run GROUP=${{ matrix.group }}');
  return {
    mode: 'dry-run', execution: 'not-run', resolution: 'declarations',
    concurrency: source.value.concurrency ?? null,
    jobs: source.jobs.map(job => {
      const value = job.value.needs;
      const dependencies: unknown[] = value === undefined ? [] : Array.isArray(value) ? value : [value];
      if (!dependencies.every((entry): entry is string => typeof entry === 'string'))
        throw new Error(`CI job ${job.id} has unreadable needs; declare job names as strings`);
      return { id: job.id, needs: dependencies, condition: job.value.if ?? null,
        strategy: job.value.strategy ?? null, uses: job.value.uses ?? null,
        steps: job.steps.map(step => ({ id: step.id ?? null, name: step.name,
          condition: step.if ?? null, run: step.run, uses: step.uses ?? null })) };
    }),
    groups: groups.map(name => {
      const assigned = targets[name] ?? [];
      const outputs = groupOutputs(assigned, needs);
      return { name, order: 'serial', targets: assigned, setupOutputs: outputs,
        setup: test.steps.slice(0, check).map(step => {
          const known = step.id !== undefined && Object.hasOwn(STEP_OUTPUT, step.id);
          if (known && step.id !== undefined && step.if !== stepCondition(step.id))
            throw new Error(`CI step ${step.id} has a different setup condition; align ci.yml with its declared setup need`);
          const output = known && step.id !== undefined ? STEP_OUTPUT[step.id] : undefined;
          const selected = known ? output == null || outputs[output] === true : step.if === undefined ? true : null;
          return { id: step.id ?? null, name: step.name, selected, condition: step.if ?? null,
            run: step.run, uses: step.uses ?? null };
        }) };
    }),
    recipes: makeTargets(makefile),
    notEvaluated: ['Make expressions and recipes', 'GitHub expressions', 'commands selected inside runner programs'],
  };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === '--group'))
      throw new Error('usage: node scripts/check/ci-plan.mts [--group <CI_GROUPS name>]');
    const root = resolve(import.meta.dirname, '../..');
    const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
    const plan = ciDeclarationPlan(readFileSync(resolve(root, 'Makefile'), 'utf8'), workflow, declaredNeeds(root));
    if (args.length) {
      const selected = plan.groups.filter(group => group.name === args[1]);
      if (!selected.length) throw new Error(`unknown CI group ${args[1]}; choose ${plan.groups.map(group => group.name).join(', ')}`);
      plan.groups = selected;
    }
    const configuration: unknown = JSON.parse(readFileSync(resolve(root, 'config/ci.json'), 'utf8'));
    const includes = plan.jobs.flatMap(job => {
      if (typeof job.uses !== 'string' || !job.uses.startsWith('./.github/workflows/')) return [];
      const file = job.uses.slice(2);
      const included = readWorkflow(readFileSync(resolve(root, file), 'utf8'), file);
      return [{ file, jobs: included.jobs.map(entry => ({ id: entry.id, ...entry.value })) }];
    });
    console.log(JSON.stringify({ ...plan, repositorySetup: configuration, includedWorkflows: includes }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
