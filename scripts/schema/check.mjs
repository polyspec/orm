import { readFile } from 'node:fs/promises';

const file = process.argv[2] ?? 'schema/schema.json';
const manifest = JSON.parse(await readFile(file, 'utf8'));
const failures = [];
for (const [entityName, entity] of Object.entries(manifest.entities ?? {})) {
  const hasAES = (entity.columns ?? []).some(column => (column.styles ?? [])[0] === 'aes');
  if (!hasAES) continue;
  const version = (entity.columns ?? []).find(column => column.name === 'aes_key_version');
  if (!version || version.nullable || !['i32', 'i64'].includes(version.type)) {
    failures.push(`${entityName}: AES columns require non-null integer aes_key_version`);
  }
  if (version && (version.styles ?? []).length > 0) {
    failures.push(`${entityName}: aes_key_version must not have an encoding style`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`schema: ${file} AES version columns passed`);
