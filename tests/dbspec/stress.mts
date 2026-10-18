// Writes a deterministic dbspec load document to standard output. Default: 2000 tables, 60000 columns, foreign keys
// 10000. All clients parse and emit the same document to time it (make bench). The output is in canonical
// form.
//
// Usage: node tests/dbspec/stress.mts [tables]
// Given tables, it writes a small document of the same shape, with 30 columns and 5 foreign keys per table. make check
// runs the same code paths (render, apply, introspect, comparison) briefly with this.

const TABLES = process.argv[2] === undefined ? 2000 : Number(process.argv[2]);
if (!Number.isInteger(TABLES) || TABLES < 2) throw new Error('usage: node tests/dbspec/stress.mts [tables >= 2]');
const COLUMNS = TABLES * 30;
const FOREIGN_KEYS = TABLES * 5;
const TYPES = ['i32', 'i64', 'bool', 'decimal(13,2)', 'f64', 'varchar(64)', 'text', 'bytes', 'uuid', 'date', 'time(0)', 'datetime(6)'];

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = seeded(1);
const name = (i: number) => `t${String(i).padStart(4, '0')}`;
// Fills each table with one id and five foreign key columns, and the rest with data columns, so the totals match exactly.
const perTable = COLUMNS / TABLES;
const fkPerTable = FOREIGN_KEYS / TABLES;
const out = ['dbspec 1 stress', ''];
for (let t = 0; t < TABLES; t++) {
  out.push(`table ${name(t)} {`);
  out.push('  id i64 identity');
  const fks = [];
  for (let k = 0; k < fkPerTable; k++) {
    let target = Math.floor(rand() * TABLES);
    if (target === t) target = (target + 1) % TABLES;
    fks.push({ column: `ref${k}_id`, target: name(target), name: `fk_${name(t)}_ref${k}` });
    out.push(`  ref${k}_id i64 null`);
  }
  for (let c = 1 + fkPerTable; c < perTable; c++) {
    out.push(`  c${String(c).padStart(2, '0')} ${TYPES[Math.floor(rand() * TYPES.length)]} null`);
  }
  out.push('  primary key (id)');
  for (const fk of fks) out.push(`  index ix_${name(t)}_${fk.column} (${fk.column})`);
  for (const fk of fks) out.push(`  foreign key ${fk.name} (${fk.column}) references ${fk.target} (id) on delete set_null on update restrict`);
  out.push('}');
  out.push('');
}
process.stdout.write(out.slice(0, -1).join('\n') + '\n');
