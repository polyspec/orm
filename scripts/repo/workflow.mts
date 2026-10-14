// workflow reads a GitHub workflow as the YAML document it is, with the yaml package: its triggers, its jobs and their
// steps. The rules of scripts/repo read the values, never the lines of the file.
import { parseDocument } from 'yaml';

/** A step of a job: its name, id, condition, action, run text and the maps of its inputs and environment. */
export type WorkflowStep = {
  name: string;
  id: string | undefined;
  if: string | undefined;
  uses: string | undefined;
  run: string;
  with: Record<string, unknown>;
  env: Record<string, unknown>;
  value: Record<string, unknown>;
};
/** A job of a workflow: its key, its value and its steps. */
export type WorkflowJob = { id: string; value: Record<string, unknown>; steps: WorkflowStep[] };
/** A workflow: its whole value and its jobs in the order the file declares them. */
export type Workflow = { value: Record<string, unknown>; jobs: WorkflowJob[] };

const isMap = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// map returns the map at key of value, an empty map when the key is absent, and throws on any other value.
function map(value: Record<string, unknown>, key: string, where: string): Record<string, unknown> {
  const item = value[key];
  if (item === undefined || item === null) return {};
  if (!isMap(item)) throw new Error(`${where} ${key} is not a map`);
  return item;
}

// text returns the string at key of value, undefined when the key is absent, and throws on any other value.
function text(value: Record<string, unknown>, key: string, where: string): string | undefined {
  const item = value[key];
  if (item === undefined) return undefined;
  if (typeof item !== 'string') throw new Error(`${where} ${key} is not a string`);
  return item;
}

function step(value: unknown, where: string): WorkflowStep {
  if (!isMap(value)) throw new Error(`${where} is not a map`);
  // A step without a name is named by its first key and value, as GitHub shows it (`uses: actions/checkout@v5`).
  const [first, firstValue] = Object.entries(value)[0] ?? ['', ''];
  return {
    name: text(value, 'name', where) ?? `${first}: ${String(firstValue)}`,
    id: text(value, 'id', where),
    if: text(value, 'if', where),
    uses: text(value, 'uses', where),
    run: text(value, 'run', where) ?? '',
    with: map(value, 'with', where),
    env: map(value, 'env', where),
    value,
  };
}

/**
 * readWorkflow parses the text of a workflow (path names it in errors). It throws on a YAML error, a duplicate key, a
 * workflow without jobs, and a workflow, job or step that is not a map: a check never reads a workflow it could not parse.
 */
export function readWorkflow(source: string, path = 'the workflow'): Workflow {
  const document = parseDocument(source, { uniqueKeys: true, prettyErrors: false });
  const error = document.errors[0];
  if (error) throw new Error(`${path} is no YAML document: ${error.message}`);
  const value: unknown = document.toJS();
  if (!isMap(value)) throw new Error(`${path} is not a map`);
  if (!isMap(value['jobs'])) throw new Error(`${path} has no map of jobs`);
  const jobs = Object.entries(value['jobs']).map(([id, job]) => {
    if (!isMap(job)) throw new Error(`${path} job ${id} is not a map`);
    const steps = job['steps'] ?? [];
    if (!Array.isArray(steps)) throw new Error(`${path} job ${id} steps is not a list`);
    return { id, value: job, steps: steps.map((item: unknown, index: number) => step(item, `${path} job ${id} step ${index + 1}`)) };
  });
  return { value, jobs };
}

/** workflowSteps is every step of every job of a workflow text, in order. */
export function workflowSteps(source: string): WorkflowStep[] {
  return readWorkflow(source).jobs.flatMap(job => job.steps);
}

/** actionSteps is every step of a workflow text that uses the action (`<action>@<ref>`). */
export function actionSteps(source: string, action: string): WorkflowStep[] {
  return workflowSteps(source).filter(item => item.uses?.split('@')[0] === action);
}

/** environment is every variable a workflow text sets: in its env map and in those of its jobs and steps. */
export function environment(source: string): Set<string> {
  const workflow = readWorkflow(source);
  return new Set([workflow.value, ...workflow.jobs.map(job => job.value)].flatMap(item => Object.keys(map(item, 'env', 'the workflow')))
    .concat(workflow.jobs.flatMap(job => job.steps.flatMap(item => Object.keys(item.env)))));
}

/** events is the events a workflow runs on: the keys of its `on` map, its `on` list or its one `on` event. */
export function events(workflow: Workflow): string[] {
  const on = workflow.value['on'];
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  return isMap(on) ? Object.keys(on) : [];
}
