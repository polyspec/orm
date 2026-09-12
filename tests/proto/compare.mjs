import { readFile } from 'node:fs/promises';

const files = process.argv.slice(2);
if (files.length !== 4) throw new Error('four compiler runner outputs are required');
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
};
const values = await Promise.all(files.map(async file => stable(JSON.parse(await readFile(file, 'utf8')))));
const expected = JSON.stringify(values[0]);
for (let index = 1; index < values.length; index += 1) {
  if (JSON.stringify(values[index]) !== expected) throw new Error(`${files[index]} differs from ${files[0]}`);
}
const value = values[0];
if (value.ir_version !== 1 || value.dialect !== 'mysql' || value.bind_parameters.join(',') !== '0,1') throw new Error(`invalid compiler result: ${expected}`);
if (!value.sql.includes('WHERE `a`.`service_seq` = ? AND (`a`.`service_seq` = ?)')) throw new Error(`scope or predicate missing: ${value.sql}`);
console.log(`proto: ${files.length} compiler transports produced identical metadata and plan`);
