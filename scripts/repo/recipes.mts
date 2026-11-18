// recipes reads what a workflow job runs through the Makefile (T497). Every job of a workflow runs one step, make ci-<job>,
// so the commands of a job are the lines of the recipe of that target and of the targets it reaches: its prerequisites, the
// targets that a line runs with $(MAKE), and the make arguments after `--` of a line of the job runner (CI_JOB,
// scripts/check/ci-job.mts). The rules of scripts/repo/ci.mts and scripts/repo/toolchains.mts read the commands of a
// workflow from here.
import { commands, type SimpleCommand, ShellParseError } from './shell.mts';
import { makeTargets } from './testcases.mts';
import { readWorkflow, type WorkflowJob, type WorkflowStep } from './workflow.mts';

/** The run step of a job and the make call it holds: the target and the arguments NAME=value. */
export type JobRun = { job: WorkflowJob; step: WorkflowStep; target: string; args: Record<string, string> };

/** makeCall reads `make <target> NAME=value...`: undefined when the text is no such one make call. */
export function makeCall(text: string): { target: string; args: Record<string, string> } | undefined {
  // An expression `${{ ... }}` is one part of its word.
  const words = text.trim().match(/(?:[^\s$]|\$(?!\{\{)|\$\{\{[^}]*\}\})+/g) ?? [];
  if (words[0] !== 'make' || !words[1] || !/^[a-z0-9][a-z0-9-]*$/.test(words[1])) return undefined;
  const args: Record<string, string> = {};
  for (const word of words.slice(2)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(word);
    if (!match?.[1]) return undefined;
    // A value is a literal or an expression of GitHub: a shell expansion, quote or operator makes the step a shell script.
    if (!/^(?:[^\s$`'"\\;&|<>()]|\$\{\{[^}]*\}\})*$/.test(match[2] ?? '')) return undefined;
    args[match[1]] = match[2] ?? '';
  }
  return { target: words[1], args };
}

/** jobRuns are the run steps of a workflow that are one make call, one for each job that has one. */
export function jobRuns(workflow: string, path?: string): JobRun[] {
  const runs: JobRun[] = [];
  for (const job of readWorkflow(workflow, path).jobs) {
    const step = job.steps.find(item => item.run !== '');
    const call = step ? makeCall(step.run) : undefined;
    if (step && call) runs.push({ job, step, ...call });
  }
  return runs;
}

// invoked returns the targets that a recipe line runs: the first word after ` -- ` of a line of the job runner, and the
// target words of a $(MAKE) or make call.
export function invoked(line: string): string[] {
  const found: string[] = [];
  const runner = /\$\(CI_JOB\)[^\n]*? -- (\S+)/.exec(line);
  if (runner?.[1]) found.push(runner[1].replace(/[,)].*$/, ''));
  for (const match of line.matchAll(/(?:\$\(MAKE\)|(?:^|[\s;&|(])make)\s+((?:[^\s;&|)]+\s*)+)/g)) {
    for (const word of (match[1] ?? '').split(/\s+/)) {
      if (word.startsWith('-') || word.includes('=') || word.includes('$') || word.includes('"') || word.includes("'")) continue;
      if (/^[a-z0-9][a-z0-9/._-]*$/.test(word)) found.push(word);
    }
  }
  return found;
}

/** reached is every target that the roots reach through prerequisites and invoked targets, roots included, in order. */
export function reached(makefile: string, roots: readonly string[]): string[] {
  const entries = makeTargets(makefile);
  const seen: string[] = [];
  const pending = [...roots];
  for (let name = pending.shift(); name !== undefined; name = pending.shift()) {
    if (seen.includes(name)) continue;
    seen.push(name);
    for (const entry of entries.filter(item => item.target === name)) {
      pending.push(...entry.prerequisites);
      for (const line of entry.commands) pending.push(...invoked(line));
    }
  }
  return seen;
}

/** recipeLines are the recipe lines of a target, of every rule that names it. */
export function recipeLines(makefile: string, target: string): string[] {
  return makeTargets(makefile).filter(entry => entry.target === target).flatMap(entry => entry.commands);
}

/** recipeCommands are the simple commands of the recipes of every target that the roots reach. */
export function recipeCommands(makefile: string, roots: readonly string[]): SimpleCommand[] {
  return reached(makefile, roots).flatMap(target => recipeLines(makefile, target)).flatMap(line => {
    // A line of the job runner runs make with the arguments after `--`, and $(MAKE) is make.
    const runner = /\$\(CI_JOB\)[^\n]*? -- (.*?)(?:,:\))?$/.exec(line);
    const text = runner?.[1] !== undefined ? `make ${runner[1]}` : line.replaceAll('$(MAKE)', 'make');
    try {
      return commands(text, 'make');
    } catch (error) {
      // A line that the shell parser does not read is no command of a tool; any other failure is thrown.
      if (!(error instanceof ShellParseError)) throw error;
      return [];
    }
  });
}

/** workflowTargets are the targets that the run steps of a workflow call. */
export function workflowTargets(workflow: string, path?: string): string[] {
  return jobRuns(workflow, path).map(run => run.target);
}

/** workflowCommands are the simple commands that a workflow runs: those of the recipes its run steps reach. */
export function workflowCommands(workflow: string, makefile: string, path?: string): SimpleCommand[] {
  return recipeCommands(makefile, workflowTargets(workflow, path));
}

// imageToolErrors returns one error for each place where a recipe of the Makefile finds a tool through the runner image rather
// than where the job's own install put it (T629, T630): a recipe line that calls brew, which no job installs, and a recipe line
// that puts ~/.cargo/bin on PATH itself. rustup is the one tool that the machine provides (kit install-rust), and it keeps rustup,
// cargo and rustc in ~/.cargo/bin, so the PATH that the Makefile exports starts with $(HOME)/.cargo/bin once for every recipe.
export function imageToolErrors(makefile: string): string[] {
  const errors: string[] = [];
  if (!/^export PATH := \$\(HOME\)\/\.cargo\/bin:/m.test(makefile)) errors.push('the Makefile does not export a PATH that starts with $(HOME)/.cargo/bin; a recipe then finds rustup and cargo through the PATH of the runner image');
  for (const entry of makeTargets(makefile))
    for (const line of entry.commands) {
      if (/(?<![\w/.@-])brew\s/.test(line)) errors.push(`${entry.target} calls brew, a tool of the runner image that no job installs; read the tool where the job's install put it: ${line.trim()}`);
      if (/\.cargo\/bin/.test(line)) errors.push(`${entry.target} puts ~/.cargo/bin on PATH itself; the PATH that the Makefile exports holds it: ${line.trim()}`);
    }
  return errors;
}
