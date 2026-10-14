// The commands of a check script as data. A script that runs commands declares them as Command values, runs them through
// keepAll or runLanes, and exports their rendered text as COMMANDS, which make repo-check reads as it reads the lines of a
// shell script (scripts/repo/check.mts): the rules about deadlines, case reports, leases and test runners hold for them.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** A word of a command: text, or the value of an environment variable that must be set when the command runs. */
export type Word = string | { variable: string };
/** A command: its program and arguments, and the folder and the variables it runs with. */
export type Command = { program: Word; args: readonly Word[]; cwd?: string; env?: Readonly<Record<string, string>> };

/** variable is the word of the environment variable name. */
export const variable = (name: string): Word => ({ variable: name });

// text is the shell text of a word: a variable is written "$NAME", as a shell script refers to it.
const text = (word: Word): string => (typeof word === 'string' ? quote(word) : `"$${word.variable}"`);

// value is the word as the command runs it; an unset variable is an error that names it, as ${NAME:?} is in a shell.
function value(word: Word): string {
  if (typeof word === 'string') return word;
  const found = process.env[word.variable];
  if (!found) throw new Error(`${word.variable} is unset; run this through make, which exports it`);
  return found;
}

// quote writes a word as the shell reads it: plain when it holds no special character, in single quotes otherwise.
const quote = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/**
 * render is the text of a command as a shell command line: cd <cwd> && unless it runs in root, then env assignments, then
 * the words; a cwd under root is written relative to it.
 */
export function render({ program, args, cwd, env }: Command, root?: string): string {
  const assignments = Object.entries(env ?? {}).map(([name, setting]) => `${name}=${quote(setting)}`);
  // A path under root is written relative to it, as the scripts of the repository write their paths.
  const relative = (word: Word): Word => (typeof word === 'string' && root !== undefined && word.startsWith(`${root}/`) ? word.slice(root.length + 1) : word);
  const words = [...(assignments.length ? ['env', ...assignments] : []), ...[program, ...args].map(relative).map(text)];
  const folder = cwd === undefined || cwd === root ? undefined : root !== undefined && cwd.startsWith(`${root}/`) ? cwd.slice(root.length + 1) : cwd;
  return `${folder === undefined ? '' : `cd ${quote(folder)} && `}${words.join(' ')}`;
}

/** run runs a command with its output passed through write, line by line, and resolves with its exit code. */
export function run(command: Command, write: (line: string) => void = line => console.log(line)): Promise<number> {
  return new Promise(resolve => {
    let program: string;
    let args: string[];
    try {
      program = value(command.program);
      args = command.args.map(value);
    } catch (error) {
      write(error instanceof Error ? error.message : String(error));
      resolve(2);
      return;
    }
    const child = spawn(program, args, { cwd: command.cwd, env: { ...process.env, ...command.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', write);
    child.on('error', error => { write(`${program}: ${error.message}`); resolve(127); });
    child.on('close', (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
}

/**
 * keepAll runs the commands in order; a failed command does not stop the next, since the commands do not read one
 * another's results. It resolves with the failed commands, each written relative to the current folder with its exit code.
 */
export async function keepAll(commands: readonly Command[], write?: (line: string) => void): Promise<string[]> {
  const failed: string[] = [];
  for (const command of commands) {
    const code = await run(command, write);
    if (code !== 0) failed.push(`${render(command, process.cwd())} (exit ${code})`);
  }
  return failed;
}

/**
 * runLanes runs each lane, a function of its line writer that resolves with its failures, together or in turn; a line of
 * a lane run together carries the prefix [<lane>], and label names the script in the failures. It resolves with the names
 * of the lanes that failed, after every lane.
 */
export async function runLanes(label: string, lanes: Readonly<Record<string, (write: (line: string) => void) => Promise<string[]>>>, together: boolean): Promise<string[]> {
  const runLane = async ([name, lane]: [string, (write: (line: string) => void) => Promise<string[]>]) => {
    const write = together ? (line: string) => console.log(`[${name}] ${line}`) : (line: string) => console.log(line);
    const failures = await lane(write);
    // A failed lane names its failed commands on standard error, each on its own line.
    if (failures.length) console.error(`${together ? `[${name}] ` : ''}${label}: the ${name} lane failed:${failures.map(failure => `\n  ${failure}`).join('')}`);
    return failures.length ? [name] : [];
  };
  const entries = Object.entries(lanes);
  if (together) return (await Promise.all(entries.map(runLane))).flat();
  const failed: string[] = [];
  for (const entry of entries) failed.push(...await runLane(entry));
  return failed;
}
