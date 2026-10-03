// dbspec 문서를 표준 Mermaid erDiagram으로 쓰고 읽는다 (docs/mermaid.md).
// 기준은 Go 엔진(engine/dbspec/mermaid.go)이며 text, 문서, 뺀 객체와 diagnostic이
// Go와 같은 바이트다. 정규식의 공백은 Go의 \s([\t\n\f\r ])로 쓴다.
import { typeText } from './emit.js';
import { byteOrder, Catalog, type DbspecUnsupported, type ITable } from './introspect_catalog.js';
import type { DbspecDiagnostic, DbspecDocument, DbspecSettings, DbspecTable, DbspecType } from './model.js';
import { validName } from './parse.js';
import { sortedBy } from './plan.js';

/** The Mermaid text and what export left out, ordered by table, kind and name. */
export interface DbspecMermaidExport {
  readonly mermaid: string;
  readonly dropped: readonly DbspecUnsupported[];
}

/** The imported document and what import left out, or the `mermaid` diagnostics and no document. */
export type DbspecMermaidImport =
  | { readonly document: DbspecDocument; readonly dropped: readonly DbspecUnsupported[]; readonly diagnostics: readonly [] }
  | { readonly document: null; readonly dropped: null; readonly diagnostics: readonly DbspecDiagnostic[] };

/**
 * Writes one document as a standard Mermaid erDiagram and lists what the
 * diagram cannot hold as [kind, table, name] in table, kind and name order
 * (docs/mermaid.md "Export").
 */
export function exportMermaid(document: DbspecDocument): DbspecMermaidExport {
  if (document === null || typeof document !== 'object' || !Array.isArray(document.tables)) {
    throw new TypeError('exportMermaid takes a parsed dbspec document');
  }
  const dropped: DbspecUnsupported[] = [];
  const report = (kind: string, table: string, name: string, reason: string): void => {
    dropped.push(Object.freeze({ kind, table, name, reason }));
  };
  for (const u of document.uses) {
    report('use', '', u.document, 'export writes the tables of one document; used tables appear only as relationship ends');
    if (u.comments.length > 0) report('comment', '', u.document, 'Mermaid has no comments on use lines');
  }
  for (const g of document.diagrams) {
    report('diagram', '', g.name, 'a dbspec diagram has no Mermaid form');
    if (g.comments.length > 0 || g.closingComments.length > 0 || g.placements.some(p => p.comments.length > 0)) {
      report('comment', '', g.name, 'Mermaid has no diagram comments');
    }
  }
  if (document.closingComments.length > 0) report('comment', '', document.name, 'Mermaid has no comments after the last block');
  const tables: DbspecTable[] = [...document.tables].sort((a, b) => byteOrder(a.name, b.name));
  let out = 'erDiagram\n';
  for (const t of tables) {
    if (t.comments.length > 0 || t.closingComments.length > 0 || t.primaryKey.comments.length > 0 || settingsCommented(t.settings)) {
      report('comment', t.name, t.name, 'Mermaid has no comments on the table, primary key and settings lines');
    }
    out += `    ${t.name} {\n`;
    for (const c of t.columns) {
      if (c.comments.length > 0) report('comment', t.name, c.name, 'Mermaid has no column comments');
      let line = `        ${mermaidType(c.type)} ${c.name}`;
      const keys: string[] = [];
      if (t.primaryKey.columns.includes(c.name)) keys.push('PK');
      if (t.foreignKeys.some(f => f.columns.includes(c.name))) keys.push('FK');
      if (t.uniques.some(u => u.columns.includes(c.name))) keys.push('UK');
      if (keys.length > 0) line += ' ' + keys.join(', ');
      const suffix: string[] = [];
      if (c.nullable) suffix.push('null');
      if (c.identity) suffix.push('identity');
      if (c.default !== null) {
        const literal = c.default.kind === 'now' ? 'now' : c.default.text;
        if (literal.includes('"')) {
          report('default', t.name, c.name, 'a Mermaid comment cannot hold the default, which contains a double quote');
        } else {
          suffix.push('default ' + literal);
        }
      }
      if (suffix.length > 0) line += ` "${suffix.join(' ')}"`;
      out += line + '\n';
    }
    out += '    }\n';
    const keyComment = (name: string, comments: readonly string[]): void => {
      if (comments.length > 0) report('comment', t.name, name, 'Mermaid has no key comments');
    };
    for (const u of t.uniques) {
      report('unique', t.name, u.name, 'Mermaid marks the columns of a unique key with UK but has no key');
      keyComment(u.name, u.comments);
    }
    for (const x of t.indexes) {
      report('index', t.name, x.name, 'Mermaid has no indexes');
      keyComment(x.name, x.comments);
    }
    for (const k of t.checks) {
      report('check', t.name, k.name, 'Mermaid has no checks');
      keyComment(k.name, k.comments);
    }
    for (const f of t.foreignKeys) {
      if (f.onDelete !== 'restrict' || f.onUpdate !== 'restrict') report('foreign_key', t.name, f.name, 'Mermaid has no foreign key actions');
      keyComment(f.name, f.comments);
    }
    if (t.settings !== null) report('settings', t.name, t.name, 'Mermaid has no settings');
  }
  for (const t of tables) {
    for (const f of sortedBy(t.foreignKeys, f => f.name)) {
      const nullable = f.columns.some(name => t.columns.find(c => c.name === name)?.nullable === true);
      const marker = nullable ? '|o--o{' : '||--o{';
      out += `    ${f.table} ${marker} ${t.name} : "${f.name} (${f.columns.join(', ')}) references (${f.references.join(', ')})"\n`;
    }
  }
  const key = (u: DbspecUnsupported): string => `${u.table}\x00${u.kind}\x00${u.name}`;
  dropped.sort((a, b) => byteOrder(key(a), key(b)));
  return Object.freeze({ mermaid: out, dropped: Object.freeze(dropped) });
}

/** settings block의 여는 줄, setting 줄, 닫는 줄 중 하나에 comment가 있는지 알려준다. */
function settingsCommented(s: DbspecSettings | null): boolean {
  return s !== null && (s.comments.length > 0 || s.closingComments.length > 0 || s.settings.some(x => x.comments.length > 0));
}

/** Mermaid type에는 쉼표가 없으므로 decimal(p,s)를 decimal(p-s)로 쓴다. */
function mermaidType(t: DbspecType): string {
  return t.kind === 'decimal' ? `decimal(${t.precision}-${t.scale})` : typeText(t);
}

// Go regexp의 \s는 [\t\n\f\r ]이다.
const S = '[\\t\\n\\f\\r ]';
const ENTITY_NAME = '([A-Za-z0-9_-]+|"[^"]*")';
const ENTITY_START = new RegExp(`^${ENTITY_NAME}${S}*\\{$`);
const ATTRIBUTE = new RegExp(
  `^([A-Za-z][A-Za-z0-9_()\\[\\]-]*)${S}+([A-Za-z_*][A-Za-z0-9_-]*)((?:${S}+(?:PK|FK|UK)(?:${S}*,${S}*(?:PK|FK|UK))*)?)(?:${S}+"([^"]*)")?$`,
);
const RELATION = new RegExp(
  `^${ENTITY_NAME}${S}+(\\|o|\\|\\||\\}o|\\}\\|)(--|\\.\\.)(o\\||\\|\\||o\\{|\\|\\{)${S}+${ENTITY_NAME}${S}*:${S}*("[^"]*"|[^\\t\\n\\f\\r "]+)$`,
);
const LABEL = /^([a-z][a-z0-9_]*) \(([a-z0-9_, ]+)\) references \(([a-z0-9_, ]+)\)$/;
// comment 뒤에 공백 하나를 붙인 text에 맞춘다. 각 부분이 공백 하나로 끝나야 하므로
// 부분 사이에 공백이 정확히 하나 있다. Go의 .은 \n 말고 모든 문자다.
const SUFFIX = /^(?:(null) )?(?:(identity) )?(?:default ([^\n]+) )?$/;
const KNOWN_TYPE = /^(i16|i32|i64|bool|f64|text|bytes|uuid|date)$|^varchar\((\d+)\)$|^(time|datetime)\((\d)\)$|^decimal\((\d+)-(\d+)\)$/;
// Go strings.TrimSpace가 지우는 Unicode 공백이다.
const GO_SPACE = '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const TRIM_SPACE = new RegExp(`^${GO_SPACE}+|${GO_SPACE}+$`, 'g');

function trimSpace(s: string): string {
  return s.replace(TRIM_SPACE, '');
}

/** Go strings.Trim(s, `"`)처럼 앞뒤의 큰따옴표를 모두 지운다. */
function trimQuotes(s: string): string {
  return s.replace(/^"+|"+$/g, '');
}

interface MermaidAttribute {
  type: string;
  name: string;
  comment: string;
  keys: string[];
}

interface MermaidEntity {
  name: string;
  attributes: MermaidAttribute[];
}

interface MermaidRelation {
  left: string;
  right: string;
  leftCard: string;
  rightCard: string;
  label: string;
}

/**
 * Reads a standard Mermaid erDiagram into a dbspec document named `name` and
 * lists what it does not carry over (docs/mermaid.md "Import"). A line that
 * does not follow the grammar is a `mermaid` diagnostic at its line.
 */
export function importMermaid(text: string, name: string): DbspecMermaidImport {
  if (typeof text !== 'string') throw new TypeError('Mermaid text must be a string');
  if (typeof name !== 'string') throw new TypeError('dbspec document name must be a string');
  const fail = (line: number, message: string): DbspecMermaidImport =>
    Object.freeze({ document: null, dropped: null, diagnostics: Object.freeze([Object.freeze({ rule: 'mermaid' as const, line, column: 1, message })]) });
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const entities: MermaidEntity[] = [];
  const byName = new Map<string, MermaidEntity>();
  const entity = (raw: string): MermaidEntity => {
    const n = trimQuotes(raw);
    let e = byName.get(n);
    if (e === undefined) {
      e = { name: n, attributes: [] };
      byName.set(n, e);
      entities.push(e);
    }
    return e;
  };
  const relations: MermaidRelation[] = [];
  let open: MermaidEntity | null = null;
  let header = false;
  for (const [i, raw] of lines.entries()) {
    const n = i + 1;
    const line = trimSpace(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (line === '' || line.startsWith('%%')) continue;
    if (!header) {
      if (line !== 'erDiagram') return fail(n, 'a Mermaid entity relationship diagram starts with erDiagram');
      header = true;
      continue;
    }
    if (open !== null) {
      if (line === '}') {
        open = null;
        continue;
      }
      const m = ATTRIBUTE.exec(line);
      if (m === null) return fail(n, 'an attribute is <type> <name> [PK|FK|UK, ...] ["comment"]');
      const keys = m[3]!.split(',').map(k => trimSpace(k)).filter(k => k !== '');
      open.attributes.push({ type: m[1]!, name: m[2]!, comment: m[4] ?? '', keys });
      continue;
    }
    const start = ENTITY_START.exec(line);
    if (start !== null) {
      open = entity(start[1]!);
      continue;
    }
    const r = RELATION.exec(line);
    if (r !== null) {
      relations.push({ left: entity(r[1]!).name, leftCard: r[2]!, rightCard: r[4]!, right: entity(r[5]!).name, label: trimQuotes(r[6]!) });
      continue;
    }
    return fail(n, 'a line is an entity block, an attribute, a relationship, a %% comment or blank');
  }
  if (!header) return fail(1, 'a Mermaid entity relationship diagram starts with erDiagram');
  if (open !== null) return fail(lines.length, `entity ${open.name} has no closing brace`);

  const c = new Catalog();
  for (const e of entities) {
    if (!validName(e.name)) {
      c.report('table', e.name, e.name, 'the entity name is not a dbspec name');
      continue;
    }
    c.addTable(e.name);
    const t = c.table(e.name)!;
    for (const a of e.attributes) {
      if (!validName(a.name)) {
        c.report('column', e.name, a.name, 'the attribute name is not a dbspec name');
        continue;
      }
      const type = importType(a.type);
      if (type === null) {
        c.report('column', e.name, a.name, `type ${a.type} is not a dbspec type`);
        continue;
      }
      const column = { name: a.name, type, nullable: false, identity: false, dflt: '' };
      if (a.comment !== '') {
        const m = SUFFIX.exec(a.comment + ' ');
        if (m !== null) {
          column.nullable = m[1] !== undefined;
          column.identity = m[2] !== undefined;
          column.dflt = m[3] ?? '';
        } else {
          c.report('comment', e.name, a.name, `the comment ${JSON.stringify(a.comment)} is not a dbspec column suffix`);
        }
      }
      t.columns.push(column);
      if (a.keys.includes('PK')) t.primary.push(a.name);
      if (a.keys.includes('UK')) c.report('unique', e.name, a.name, 'Mermaid does not say which UK attributes form one key');
    }
  }
  const columnIn = (t: ITable, n: string) => t.columns.find(col => col.name === n);
  const isFK = (entityName: string, column: string): boolean => {
    const a = byName.get(entityName)!.attributes.find(x => x.name === column);
    return a !== undefined && a.keys.includes('FK');
  };
  const usedFK = new Map<string, Set<string>>();
  for (const r of relations) {
    let parent = r.left;
    let child = r.right;
    let parentCard = r.leftCard;
    let childCard = r.rightCard;
    const manyRight = r.rightCard.endsWith('{');
    const manyLeft = r.leftCard.startsWith('}');
    if (manyLeft === manyRight) {
      c.report('relationship', r.left, r.label, `the relationship to ${r.right} is not one to many`);
      continue;
    }
    if (manyLeft) [parent, child, parentCard, childCard] = [r.right, r.left, r.rightCard, r.leftCard];
    const m = LABEL.exec(r.label);
    const pt = c.table(parent);
    const ct = c.table(child);
    if (m === null || pt === undefined || ct === undefined) {
      c.report('relationship', child, r.label, 'the label does not give the foreign key columns, or an end is not a table');
      continue;
    }
    const cols = splitNames(m[2]!);
    const refs = splitNames(m[3]!);
    let ok = cols.length === refs.length;
    let nullable = false;
    if (ok) {
      for (const [i, col] of cols.entries()) {
        const cc = columnIn(ct, col);
        if (cc === undefined || !isFK(child, col) || columnIn(pt, refs[i]!) === undefined) {
          ok = false;
          break;
        }
        nullable = nullable || cc.nullable;
      }
    }
    if (!ok) {
      c.report('relationship', child, m[1]!, `its columns are not FK attributes of ${child} or its referenced columns are not attributes of ${parent}`);
      continue;
    }
    let wantParent = nullable ? '|o' : '||';
    if (manyLeft) wantParent = wantParent === '|o' ? 'o|' : '||';
    if (parentCard !== wantParent || (childCard !== 'o{' && childCard !== '}o')) {
      c.report('cardinality', child, m[1]!, "the cardinalities differ from the ones the foreign key's nullability gives");
    }
    ct.fks.push({ name: m[1]!, columns: cols, table: parent, refs, onDelete: 'restrict', onUpdate: 'restrict' });
    let used = usedFK.get(child);
    if (used === undefined) usedFK.set(child, (used = new Set()));
    for (const col of cols) used.add(col);
    const prefix = ct.primary.slice(0, Math.min(cols.length, ct.primary.length));
    const ix = `ix_${child}_${cols.join('_')}`;
    // 같은 column의 foreign key가 이미 더한 index는 다시 더하지 않는다.
    const indexed = ct.indexes.some(x => x.name === ix);
    if ((prefix.length !== cols.length || prefix.some((p, i) => p !== cols[i])) && !indexed) {
      ct.indexes.push({ name: ix, columns: cols, desc: cols.map(() => false) });
      c.report('index', child, ix, 'Mermaid has no indexes; the foreign key needs one');
    }
  }
  for (const e of entities) {
    for (const a of e.attributes) {
      if (a.keys.includes('FK') && usedFK.get(e.name)?.has(a.name) !== true && c.table(e.name) !== undefined) {
        c.report('foreign_key', e.name, a.name, 'no relationship gives the foreign key of this FK attribute');
      }
    }
  }
  let result: { document: DbspecDocument; unsupported: DbspecUnsupported[] };
  try {
    result = c.document(name);
  } catch (error) {
    // catalog이 문서를 만들지 못하면(문서 이름이 dbspec 이름이 아닌 경우 등) Go처럼 1행의 diagnostic이다.
    return fail(1, error instanceof Error ? error.message : String(error));
  }
  return Object.freeze({
    document: result.document,
    dropped: Object.freeze(result.unsupported.map(u => Object.freeze({ ...u }))),
    diagnostics: Object.freeze([]) as readonly [],
  });
}

function splitNames(s: string): string[] {
  return s.split(',').map(p => trimSpace(p));
}

/** 숫자 text가 lo 이상 hi 이하인 값이면 그 값을, 아니면 null을 돌려준다. 9자리를 넘는 수는 범위 밖이다. */
function within(digits: string, lo: number, hi: number): number | null {
  const significant = digits.replace(/^0+/, '');
  if (significant.length > 9) return null;
  const n = Number(significant);
  return n >= lo && n <= hi ? n : null;
}

/**
 * Mermaid type이 dbspec type이면 그 type을, 아니면 null을 돌려준다. 수가 dbspec 범위
 * (varchar 1-16383, time과 datetime 0-6, decimal p 1-18과 s 0-p)를 벗어나면 dbspec
 * type이 아니다. 범위를 여기서 정하므로 key column도 모든 client에서 같은 지점에서 빠진다.
 */
function importType(s: string): DbspecType | null {
  const m = KNOWN_TYPE.exec(s);
  if (m === null) return null;
  if (m[1] !== undefined) return { kind: m[1] as 'i16' };
  if (m[2] !== undefined) {
    const length = within(m[2], 1, 16383);
    return length === null ? null : { kind: 'varchar', length };
  }
  if (m[3] !== undefined) {
    const precision = within(m[4]!, 0, 6);
    return precision === null ? null : { kind: m[3] as 'time' | 'datetime', precision };
  }
  const precision = within(m[5]!, 1, 18);
  const scale = precision === null ? null : within(m[6]!, 0, precision);
  return precision === null || scale === null ? null : { kind: 'decimal', precision, scale };
}
