// The checklists of a repository: the documents whose items carry a state, declared in config/checklist.json. The push gate
// (push-gate.mjs) and the guard of the full run (full-run.mjs) read the items that are in the active state of each
// checklist; the document check (check-documents.mjs) reads the same checklists strictly. One function, readChecklist,
// reads a checklist at both levels.
//
// A table tracker has one row per item, `| ID | title | ... | state |`; the state is the last cell or the cell `column`.
// A list tracker has one line per item, `- [state] ID text`, indented for a sub-item. A state is the leading `[x]` of
// its cell or item, or the whole cell when the cell does not start with `[`. A tracker that cannot be read is an error
// and never an empty result: the gate refuses a push whose items it cannot read.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tableCells } from './markdown.mjs';
import { readConfig } from './schema-validate.mjs';

export const CONFIG = 'config/checklist.json';
export const PRE_PUSH_HOOK = 'pre-push';

const DEFAULT_ID = '[A-Za-z][A-Za-z0-9.-]*';
const SEPARATOR_CELL = /^:?-{3,}:?$/;
const LIST_ITEM = /^( *)- (\[[^\]]*\]) (\S+)\s*(.*)$/;

/** The configuration of the checkout `root`; throws with every finding when it breaks the schema or a rule of the tools. */
export function loadConfig(root) {
  const file = path.join(root, CONFIG);
  if (!existsSync(file)) throw new Error(`${CONFIG} does not exist in ${root}; the repository declares its trackers and hooks there`);
  const { value: config, errors: findings } = readConfig(root, CONFIG, 'checklist.schema.json');
  if (findings.length === 0) {
    if (!config.hooks.includes(PRE_PUSH_HOOK)) findings.push(`${CONFIG}: $.hooks is ${JSON.stringify(config.hooks)}, it must include "${PRE_PUSH_HOOK}", which runs the push gate`);
    const paths = config.trackers.flatMap(tracker => [tracker.path, ...(tracker.translation ? [tracker.translation] : [])]);
    for (const duplicate of paths.filter((item, index) => paths.indexOf(item) !== index)) findings.push(`${CONFIG}: ${duplicate} is declared twice in $.trackers`);
    for (const tracker of config.trackers) {
      if (tracker.states && !tracker.states.includes(tracker.active)) findings.push(`${CONFIG}: $.trackers ${tracker.path} has the active state ${JSON.stringify(tracker.active)}, which is not in its states ${JSON.stringify(tracker.states)}`);
    }
  }
  if (findings.length > 0) throw new Error(findings.join('\n'));
  return config;
}

const MARKER = /\[[ ~o!xX]\]/g;
const DOCUMENT_MARKER = /^<!-- (?:doc-id|source-sha256): \S+ -->$/;
const HEADING = /^#{1,6} \S/;
const TABLE_BYPASS = /^\[!\] (?:cause|원인): \S.*; (?:retry|재시도): \S.*$/;
const BYPASSED = '[!]';
const FOUR_STATES = ['[ ]', '[~]', '[o]', '[!]'];
// The first cell of a task row is the task ID, which a code span may follow: `T3.2 \`parallel\``.
const ID_CELL = /^(\S+)(?:\s+`[^`]*`)?$/;

const stateOf = cell => /^\[[^\]]*\]/.exec(cell)?.[0] ?? cell;
const firstSentence = text => /^(.+?\.)(?:\s|$)/.exec(text)?.[1] ?? text.trim();
const isSeparator = row => row.length > 0 && row.every(cell => SEPARATOR_CELL.test(cell.text.trim()));
const listOf = words => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`);

/** A finding as one sentence: `line 3: ...` when it has a line. */
export const describeFinding = finding => (finding.line ? `line ${finding.line}: ${finding.message}` : finding.message);

/**
 * Reads the checklist of `text` as the tracker `tracker` declares it (format, idPattern, column, states). Returns
 * `{ items, findings }`: the items as `{ id, title, state, line }` with the state as the document writes it, for example
 * `[o]`, and the findings as `{ line, column, rule, message }`.
 *
 * The lenient reading (the default) is the reading of the push gate and the guard of the full run. It looks only at the
 * items and reports what makes the document unreadable as a tracker: a row or an item that is malformed, a state outside
 * `states`, an ID listed twice and a document without an item.
 *
 * The strict reading (`strict: true`) is the reading of the document check. It reports the same and also that a checklist
 * holds only tasks: a line that is not a heading, a task or a document marker; a state marker that is not the state of a
 * task; a state cell that holds more than its state (a table state is alone in its cell, but `[!]` is followed by
 * `cause: <cause>; retry: <condition>`); a bypassed list item without `Cause:` and `Retry:`. The Korean labels 원인: and
 * 재시도: are accepted. Each finding has a line and a column.
 */
export function readChecklist(text, tracker, { strict = false } = {}) {
  const { format, states } = tracker;
  const id = new RegExp(`^(?:${tracker.idPattern ?? DEFAULT_ID})$`);
  const findings = [];
  const items = [];
  const seen = new Map();
  const finding = (line, column, rule, message) => findings.push({ line, column, rule, message });
  const both = (line, column, rule, strictMessage, plainMessage) => finding(line, column, rule, strict ? strictMessage : plainMessage);
  const strictOnly = (...found) => { if (strict) finding(...found); };
  const plainOnly = (line, rule, message) => { if (!strict) finding(line, undefined, rule, message); };
  const expected = states ?? FOUR_STATES;
  const expectedCell = listOf(expected.map(known => (known === BYPASSED ? `${known} cause: <cause>; retry: <condition>` : known)));
  const stateRule = (task, number, column, shown, state) => {
    if (states && !states.includes(state)) {
      both(number, column, 'checklist-state', `the state of ${task} is ${shown}; expected ${(format === 'table' ? expectedCell : listOf(expected))}`, `${task} has the state ${JSON.stringify(state)}, the states are ${states.map(known => JSON.stringify(known)).join(', ')}`);
      return false;
    }
    return true;
  };
  const add = (number, item) => {
    if (seen.has(item.id)) both(number, 1, 'checklist-duplicate', `the task ${item.id} has a second row; the first is on line ${seen.get(item.id)}`, `the item ${item.id} is listed twice`);
    else seen.set(item.id, number);
    items.push({ ...item, line: number });
  };
  const lines = text.replace(/\n$/, '').split('\n');
  let current = null;
  const lists = [];
  lines.forEach((line, index) => {
    const number = index + 1;
    const indent = Math.max(line.search(/\S/), 0);
    let place = -1;
    let allowed = line.trim() === '' || HEADING.test(line) || DOCUMENT_MARKER.test(line);
    if (format === 'table') {
      const row = line.trimStart().startsWith('|') ? tableCells(line) : [];
      const first = row[0]?.text.trim() ?? '';
      const task = ID_CELL.exec(first)?.[1];
      if (isSeparator(row) || (row.length > 0 && (first === 'ID' || isSeparator(tableCells(lines[index + 1] ?? ''))))) {
        allowed = true;
      } else if (task && id.test(task)) {
        allowed = true;
        const column = tracker.column ?? row.length - 1;
        if (column === 0 || row.length <= column) {
          both(number, indent + 1, 'checklist-state', `the row of ${task} has ${row.length} cells; expected a state cell at position ${column + 1}`, `${JSON.stringify(line.trim().slice(0, 60))} is not a row with an ID in its first cell and a state in cell ${column + 1}`);
        } else {
          const cell = row[column];
          const state = cell.text.trim();
          place = cell.start + cell.text.search(/\S/);
          if (strict && (!line.trimEnd().endsWith('|') || !state)) {
            finding(number, line.length + 1, 'checklist-state', `the row of ${task} does not end with a state cell; expected a closing | after ${expectedCell}`);
          } else {
            const kept = stateOf(state);
            const alone = !strict || state === kept || (kept === BYPASSED && TABLE_BYPASS.test(state));
            if (alone) stateRule(task, number, place + 1, JSON.stringify(state), kept);
            else both(number, place + 1, 'checklist-state', `the state of ${task} is ${JSON.stringify(state)}; expected ${expectedCell}`);
            add(number, { id: task, title: row[1]?.text.trim() ?? '', state: kept });
          }
        }
      } else if (row.length > 0) {
        plainOnly(number, 'checklist-state', `${JSON.stringify(line.trim().slice(0, 60))} is not a row with an ID in its first cell and a state in cell ${(tracker.column ?? row.length - 1) + 1}`);
      }
      if (!allowed) {
        const where = row.length ? `the first cell ${JSON.stringify(first)} is not a task ID matching ${tracker.idPattern ?? DEFAULT_ID}` : 'the line is not a heading or a task table row';
        strictOnly(number, indent + 1, 'checklist-line', `${where}; a checklist holds only tasks, so its plan and notes belong in another document`);
      }
    } else {
      const attempt = /^ *- \[/.test(line);
      const entry = LIST_ITEM.exec(line);
      if (attempt && entry && id.test(entry[3])) {
        allowed = true;
        place = entry[1].length + 2;
        stateRule(entry[3], number, place + 1, entry[2], entry[2]);
        add(number, { id: entry[3], title: firstSentence(entry[4]), state: entry[2] });
        current = { id: entry[3], state: entry[2], line: number, text: line, indent: entry[1].length };
        lists.push(current);
      } else if (attempt) {
        plainOnly(number, 'checklist-line', `${JSON.stringify(line.trim())} is not an item of the form "- [state] ID text"`);
      } else if (current && /^ +\S/.test(line) && indent > current.indent) {
        allowed = true;
        current.text += `\n${line}`;
      }
      if (HEADING.test(line)) current = null;
      if (!allowed) strictOnly(number, indent + 1, 'checklist-line', 'the line is not a heading, a task item "- [ ] <ID> text" or the continuation of one; a checklist holds only tasks');
    }
    if (strict) {
      for (const marker of line.matchAll(MARKER)) {
        if (marker.index !== place) finding(number, marker.index + 1, 'checklist-marker', `the state marker ${marker[0]} is not the state of a task; a state marker stands only at the start of ${format === 'table' ? `${tracker.column === undefined ? 'the last' : 'the state'} cell of a task row` : 'a task item'}`);
      }
    }
  });
  // A bypassed list item names its cause and its retry condition on the item or its continuation lines.
  if (strict) {
    for (const entry of lists.filter(candidate => candidate.state === BYPASSED)) {
      if (!/(?:cause|원인):\s*\S/i.test(entry.text)) finding(entry.line, 1, 'checklist-state', `the bypassed task ${entry.id} names no cause; write "Cause: <cause>" on the item`);
      if (!/(?:retry|재시도):\s*\S/i.test(entry.text)) finding(entry.line, 1, 'checklist-state', `the bypassed task ${entry.id} names no retry condition; write "Retry: <condition>" on the item`);
    }
  }
  if (items.length === 0 && (strict || findings.length === 0)) {
    if (strict) finding(1, 1, 'checklist-empty', `the checklist has no task whose ID matches ${tracker.idPattern ?? DEFAULT_ID}`);
    else finding(undefined, undefined, 'checklist-empty', 'it has no item');
  }
  return { items, findings };
}

/** The items of `text` in the active state of `tracker`; throws with every finding when the text cannot be read. */
export function activeItems(text, tracker) {
  const { items, findings } = readChecklist(text, tracker);
  if (findings.length > 0) throw new Error(findings.map(describeFinding).join('; '));
  return items.filter(item => item.state === tracker.active);
}

/**
 * The differences between the items of a document and of its translation: IDs in another order or missing, and states
 * that differ. A strict difference names the line of the translation and the rule `checklist-pair`.
 */
export function twinFindings(english, korean, tracker, { strict = false } = {}) {
  const ids = items => items.map(item => item.id).join(' ');
  if (ids(english) !== ids(korean)) {
    if (strict) return [{ rule: 'checklist-pair', message: `the task IDs differ from ${tracker.path}: [${ids(korean)}] and [${ids(english)}]` }];
    const missing = english.filter(item => !korean.some(other => other.id === item.id)).map(item => item.id);
    const extra = korean.filter(item => !english.some(other => other.id === item.id)).map(item => item.id);
    return [{ rule: 'checklist-pair', message: `${tracker.translation} lists other items than ${tracker.path}: missing ${missing.join(', ') || 'none'}, extra ${extra.join(', ') || 'none'}${missing.length + extra.length === 0 ? ', in another order' : ''}` }];
  }
  return english.flatMap((item, index) => (item.state === korean[index].state ? [] : [strict
    ? { line: korean[index].line, column: 1, rule: 'checklist-pair', message: `the state of ${item.id} is ${korean[index].state}; ${tracker.path} has ${item.state}` }
    : { rule: 'checklist-pair', message: `${item.id} is ${item.state} in ${tracker.path} and ${korean[index].state} in ${tracker.translation}` }]));
}

/** The differences between a document and its translation, read leniently; throws when either cannot be read. */
export function compareTwin(english, korean, tracker) {
  const a = readChecklist(english, tracker);
  const b = readChecklist(korean, tracker);
  if (a.findings.length > 0 || b.findings.length > 0) {
    throw new Error([...a.findings.map(found => `${tracker.path}: ${describeFinding(found)}`), ...b.findings.map(found => `${tracker.translation}: ${describeFinding(found)}`)].join('; '));
  }
  return twinFindings(a.items, b.items, tracker).map(found => found.message);
}

/**
 * The state of every tracker as read by `read(file)`, which returns the text of a file or throws why it cannot. Returns
 * `{ active, problems }`: the active items as `{ file, id, title }` and the sentences that name what cannot be read.
 */
export function inspectTrackers(config, read) {
  const active = [];
  const problems = [];
  for (const tracker of config.trackers) {
    let english;
    try {
      english = read(tracker.path);
      for (const item of activeItems(english, tracker)) active.push({ file: tracker.path, id: item.id, title: item.title });
    } catch (error) {
      problems.push(`${tracker.path}: ${error.message}`);
      continue;
    }
    if (!tracker.translation) continue;
    let korean;
    try {
      korean = read(tracker.translation);
    } catch (error) {
      problems.push(`${tracker.translation}: ${error.message}`);
      continue;
    }
    try {
      problems.push(...compareTwin(english, korean, tracker));
    } catch (error) {
      problems.push(error.message);
    }
  }
  return { active, problems };
}

/** The sentence that says which states stop a push and which do not. */
export function blockingSentence(config) {
  return config.trackers.map((tracker) => {
    const others = (tracker.states ?? []).filter(state => state !== tracker.active);
    return `${tracker.path}: only the state ${tracker.active} blocks${others.length > 0 ? `; ${others.join(', ')} do not block` : ''}`;
  }).join('; ');
}
