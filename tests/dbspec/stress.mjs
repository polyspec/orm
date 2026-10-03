// 결정적 dbspec 부하 문서를 표준 출력으로 쓴다: 기본은 table 2000개, column 60000개, foreign key
// 10000개다. 모든 client가 같은 문서를 parse하고 emit해 시간을 잰다(make bench). 출력은 canonical
// form이다.
//
// Usage: node tests/dbspec/stress.mjs [tables]
// tables를 주면 table마다 column 30개와 foreign key 5개인 같은 모양의 작은 문서를 쓴다. make check는
// 이것으로 같은 code path(render, apply, introspect, 비교)를 짧게 실행한다.

const TABLES = process.argv[2] === undefined ? 2000 : Number(process.argv[2]);
if (!Number.isInteger(TABLES) || TABLES < 2) throw new Error('usage: node tests/dbspec/stress.mjs [tables >= 2]');
const COLUMNS = TABLES * 30;
const FOREIGN_KEYS = TABLES * 5;
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
