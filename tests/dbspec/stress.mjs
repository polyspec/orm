// 결정적 dbspec 부하 문서를 표준 출력으로 쓴다: table 2000개, column 60000개, foreign key 10000개.
// 모든 client가 같은 문서를 parse하고 emit해 시간을 잰다. 출력은 canonical form이다.

const TABLES = 2000;
const COLUMNS = 60000;
const FOREIGN_KEYS = 10000;
const TYPES = ['i32', 'i64', 'bool', 'decimal(13,2)', 'f64', 'varchar(64)', 'text', 'bytes', 'uuid', 'date', 'time(0)', 'datetime(6)'];

function seeded(seed) {
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
const name = (i) => `t${String(i).padStart(4, '0')}`;
// table마다 id 하나와 foreign key column 다섯 개, 나머지는 data column으로 채워 합계를 정확히 맞춘다.
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
