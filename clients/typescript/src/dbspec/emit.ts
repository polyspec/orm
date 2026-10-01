// Canonical dbspec emission (docs/dbspec.md, "Canonical form"). A comment
// takes the indentation of the line it attaches to; a comment before a
// closing brace takes the indentation of the block's lines.
import type {
  DbspecDocument,
  DbspecDefault,
  DbspecForeignKey,
  DbspecIndex,
  DbspecSetting,
  DbspecTable,
  DbspecType,
} from './model.js';

const SETTING_ORDER: readonly DbspecSetting['kind'][] = [
  'entity',
  'updated',
  'soft_delete',
  'select_explicit',
  'codec',
  'aes_version',
  'blind_index',
  'navigation',
  'immutable',
  'audit',
];

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sorted<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => compare(key(a), key(b)));
}

function comments(out: string[], lines: readonly string[], indent: string): void {
  for (const line of lines) out.push(indent + line);
}

export function typeText(type: DbspecType): string {
  switch (type.kind) {
    case 'decimal':
      return `decimal(${type.precision},${type.scale})`;
    case 'varchar':
      return `varchar(${type.length})`;
    case 'time':
    case 'datetime':
      return `${type.kind}(${type.precision})`;
    default:
      return type.kind;
  }
}

function defaultText(value: DbspecDefault): string {
  return value.kind === 'now' ? 'now' : value.text;
}

function settingKey(setting: DbspecSetting): string {
  if (setting.kind === 'codec') return setting.column;
  if (setting.kind === 'navigation') return setting.foreignKey;
  return '';
}

function settingText(setting: DbspecSetting): string {
  switch (setting.kind) {
    case 'entity':
      return `entity ${setting.name}`;
    case 'updated':
    case 'soft_delete':
    case 'aes_version':
      return `${setting.kind} ${setting.column}`;
    case 'select_explicit':
      return `select explicit ${setting.columns.join(' ')}`;
    case 'codec':
      return `codec ${setting.column} ${setting.stages.join(' ')}`;
    case 'blind_index':
      return `blind_index ${setting.column} ${setting.indexColumn}`;
    case 'navigation':
      return `navigation ${setting.foreignKey} ${setting.childName} ${setting.parentName}`;
    case 'immutable':
      return 'immutable';
    case 'audit':
      return `audit into ${setting.into} operation ${setting.operation} action ${setting.action} previous ${setting.previous}`;
  }
}

function indexText(index: DbspecIndex): string {
  const columns = index.columns.map(c => (c.descending ? `${c.name} desc` : c.name));
  return `index ${index.name} (${columns.join(', ')})`;
}

function foreignKeyText(fk: DbspecForeignKey): string {
  return (
    `foreign key ${fk.name} (${fk.columns.join(', ')}) references ${fk.table} (${fk.references.join(', ')})` +
    ` on delete ${fk.onDelete} on update ${fk.onUpdate}`
  );
}

function table(out: string[], t: DbspecTable): void {
  comments(out, t.comments, '');
  out.push(`table ${t.name} {`);
  for (const c of t.columns) {
    comments(out, c.comments, '  ');
    let line = `  ${c.name} ${typeText(c.type)}`;
    if (c.nullable) line += ' null';
    if (c.identity) line += ' identity';
    if (c.default !== null) line += ` default ${defaultText(c.default)}`;
    out.push(line);
  }
  comments(out, t.primaryKey.comments, '  ');
  out.push(`  primary key (${t.primaryKey.columns.join(', ')})`);
  for (const u of sorted(t.uniques, u => u.name)) {
    comments(out, u.comments, '  ');
    out.push(`  unique ${u.name} (${u.columns.join(', ')})`);
  }
  for (const i of sorted(t.indexes, i => i.name)) {
    comments(out, i.comments, '  ');
    out.push(`  ${indexText(i)}`);
  }
  for (const fk of sorted(t.foreignKeys, fk => fk.name)) {
    comments(out, fk.comments, '  ');
    out.push(`  ${foreignKeyText(fk)}`);
  }
  for (const c of sorted(t.checks, c => c.name)) {
    comments(out, c.comments, '  ');
    out.push(`  check ${c.name} (${c.expression})`);
  }
  // An empty settings block has no meaning: canonical form omits it and keeps its comments before the closing brace.
  const empty = t.settings !== null && t.settings.settings.length === 0;
  if (t.settings !== null && !empty) {
    comments(out, t.settings.comments, '  ');
    out.push('  settings {');
    const settings = [...t.settings.settings].sort(
      (a, b) => SETTING_ORDER.indexOf(a.kind) - SETTING_ORDER.indexOf(b.kind) || compare(settingKey(a), settingKey(b)),
    );
    for (const s of settings) {
      comments(out, s.comments, '    ');
      out.push(`    ${settingText(s)}`);
    }
    comments(out, t.settings.closingComments, '    ');
    out.push('  }');
  }
  if (t.settings !== null && empty) {
    comments(out, t.settings.comments, '  ');
    comments(out, t.settings.closingComments, '  ');
  }
  comments(out, t.closingComments, '  ');
  out.push('}');
}

export function emitDocument(document: DbspecDocument): string {
  const out: string[] = [`dbspec 1 ${document.name}`];
  const uses = sorted(document.uses, u => u.document);
  if (uses.length > 0) out.push('');
  for (const u of uses) {
    comments(out, u.comments, '');
    out.push(`use ${u.document} { ${u.tables.join(', ')} }`);
  }
  for (const t of document.tables) {
    out.push('');
    table(out, t);
  }
  for (const d of document.diagrams) {
    out.push('');
    comments(out, d.comments, '');
    out.push(`diagram ${d.name} {`);
    for (const p of d.placements) {
      comments(out, p.comments, '  ');
      out.push(`  ${p.table} at ${p.x} ${p.y}`);
    }
    comments(out, d.closingComments, '  ');
    out.push('}');
  }
  if (document.closingComments.length > 0) {
    out.push('');
    comments(out, document.closingComments, '');
  }
  return out.join('\n') + '\n';
}
