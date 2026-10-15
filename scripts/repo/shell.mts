// shell reads the commands that the checks of this repository run, with the shell parser unbash: the recipes of the
// Makefile, the run text of the workflow steps, the verification commands of contracts/features.json, the scripts of
// package.json and the command lines of the scripts of scripts/. A rule of scripts/repo looks at each simple command
// (a segment) that such text runs.
import { parse } from 'unbash';
import type { CompoundList, PipelineNode, Script, Statement } from 'unbash';

/**
 * The language a command text is written in. `sh` is a shell command or script. `make` is a recipe line of the Makefile:
 * make removes the prefixes `@`, `-` and `+`, reads `$$` as `$`, and replaces each reference to a variable or function
 * (`$(NAME)`, `${NAME}`, `$(fn args)`, `$X`) before the shell runs it. `workflow` is the run text of a GitHub workflow
 * step, in which GitHub replaces each expression `${{ ... }}` before the shell runs it.
 */
export type Dialect = 'sh' | 'make' | 'workflow';

// A substitution the shell never sees (a make reference, a GitHub expression) is read as one word of this text.
const VALUE = 'VALUE';

/** Shell text and, for each of its characters, the range of the original text it came from. */
type Mapped = { shell: string; from: number[]; to: number[] };

// closing returns the index just past the `)` or `}` that closes the reference opened at text[start] (a `(` or `{`),
// counting the nested ones of the same kind as make does. It throws on a reference that never closes.
function closing(text: string, start: number): number {
  const open = text[start];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === open) depth++;
    else if (text[index] === close && --depth === 0) return index + 1;
  }
  throw new Error(`the make reference at ${start - 1} never closes: ${text}`);
}

// shellOf turns the text of a dialect into the text the shell parses, keeping where each character came from.
function shellOf(text: string, dialect: Dialect): Mapped {
  const mapped: Mapped = { shell: '', from: [], to: [] };
  const add = (value: string, from: number, to: number) => {
    for (const char of value) { mapped.shell += char; mapped.from.push(from); mapped.to.push(to); }
  };
  let index = 0;
  // make removes the prefixes of a recipe line before the shell runs it.
  if (dialect === 'make') while (index < text.length && /[@+\-\s]/.test(text[index] ?? '')) index++;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (dialect === 'make' && char === '$') {
      const next = text[index + 1];
      if (next === '$') { add('$', index, index + 2); index += 2; continue; }
      if (next === '(' || next === '{') { const end = closing(text, index + 1); add(VALUE, index, end); index = end; continue; }
      if (next === undefined) throw new Error(`a make recipe ends with a lone $: ${text}`);
      add(VALUE, index, index + 2); index += 2; continue;
    }
    if (dialect === 'workflow' && text.startsWith('${{', index)) {
      const end = text.indexOf('}}', index);
      if (end === -1) throw new Error(`the workflow expression at ${index} never closes: ${text}`);
      add(VALUE, index, end + 2); index = end + 2; continue;
    }
    add(char, index, index + 1);
    index++;
  }
  return mapped;
}

/**
 * script parses a command text of a dialect. It throws on a syntax error, with the error and the text: a check never reads
 * a command it could not parse.
 */
function script(text: string, dialect: Dialect): { tree: Script; mapped: Mapped } {
  const mapped = shellOf(text, dialect);
  const tree = parse(mapped.shell);
  const error = tree.errors?.[0];
  if (error) throw new Error(`the shell parser rejects this ${dialect} command at ${mapped.from[error.pos] ?? text.length}: ${error.message}: ${text}`);
  return { tree, mapped };
}

// walk calls visit on each node of the tree that a command text runs, from the statements of the script into the lists,
// pipelines, subshells, groups and the bodies of the compound commands. It never enters a word.
function walk(tree: Script, text: string, visit: (node: PipelineNode | Statement['command']) => void): void {
  const list = (statements: readonly Statement[]) => { for (const statement of statements) node(statement.command); };
  const body = (compound: CompoundList) => list(compound.commands);
  const node = (command: PipelineNode | CompoundList | Statement['command'] | undefined): void => {
    if (command === undefined) return;
    if (command.type !== 'CompoundList') visit(command);
    switch (command.type) {
      case 'Command': case 'TestCommand': case 'ArithmeticCommand': return;
      case 'AndOr': case 'Pipeline': command.commands.forEach(node); return;
      case 'Time': case 'Negation': case 'Redirected': node(command.command); return;
      case 'CompoundList': body(command); return;
      case 'Subshell': case 'BraceGroup': case 'For': case 'Select': case 'ArithmeticFor': body(command.body); return;
      case 'While': body(command.clause); body(command.body); return;
      case 'If': body(command.clause); body(command.then); node(command.else); return;
      case 'Case': for (const item of command.items) body(item.body); return;
      case 'Function': case 'Coproc': node(command.body); return;
      default: throw new Error(`the shell reader does not know the node ${(command as { type: string }).type}: ${text}`);
    }
  };
  list(tree.commands);
}

// original returns the original text of the shell range [pos, end).
const original = (text: string, mapped: Mapped, pos: number, end: number) =>
  text.slice(mapped.from[pos] ?? text.length, mapped.to[end - 1] ?? text.length).trim();

/**
 * segments returns each simple command that a command text runs, in order, as the original text of that command: the
 * commands that `&&`, `||`, `;`, `|`, a newline, a subshell `( )`, a group `{ }` and the bodies of `if`, `for`, `while`,
 * `case` and functions hold. A command substitution `$(...)` and a quoted string (`sh -c '...'`) are words of their
 * command, not commands of the text. The keywords and the word lists of the compound commands are not commands.
 */
export function segments(text: string, dialect: Dialect): string[] {
  const { tree, mapped } = script(text, dialect);
  const out: string[] = [];
  walk(tree, text, node => {
    if (node.type === 'Command' || node.type === 'TestCommand' || node.type === 'ArithmeticCommand') out.push(original(text, mapped, node.pos, node.end));
  });
  return out;
}

/**
 * shellSegments returns the segments of a command text as the shell sees them: a make reference or a GitHub expression is
 * the one word VALUE and a make `$$` is `$`. A rule that reads the program a command runs, whatever a make function
 * computes for one of its words, reads these.
 */
export function shellSegments(text: string, dialect: Dialect): string[] {
  const { tree, mapped } = script(text, dialect);
  const out: string[] = [];
  walk(tree, text, node => {
    if (node.type === 'Command' || node.type === 'TestCommand' || node.type === 'ArithmeticCommand') out.push(mapped.shell.slice(node.pos, node.end).trim());
  });
  return out;
}

/**
 * andLists returns each list of commands that `&&` joins in a command text, as the original text of each command of the
 * list: a failure of one stops the ones after it. `a && b || c && d` holds the lists [a, b] and [c, d].
 */
export function andLists(text: string, dialect: Dialect): string[][] {
  const { tree, mapped } = script(text, dialect);
  const out: string[][] = [];
  walk(tree, text, node => {
    if (node.type !== 'AndOr') return;
    let current: string[] = [];
    node.commands.forEach((command, index) => {
      current.push(original(text, mapped, command.pos, command.end));
      if (node.operators[index] !== '&&') { if (current.length > 1) out.push(current); current = []; }
    });
  });
  return out;
}
