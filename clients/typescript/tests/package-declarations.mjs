// The published declarations type-check in a project that has none of the driver types.
// The case packs the package with npm pack, installs the tarball's files and its declared
// type dependency ordered-json into a temporary project, adds @types/node with its
// undici-types (a Node project has them) but neither pg, @types/pg nor mysql2, and runs tsc with skipLibCheck
// off over a source that imports the public API, the dbspec apply and introspection
// declarations included. A declaration that names a driver module fails with TS2307 or
// TS7016. The case also rejects a declaration file that imports pg, mysql2 or
// node:sqlite, so the declarations type-check with the MySQL or SQLite driver alone.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCase } from '../../../tests/testcase.mjs';

const client = new URL('..', import.meta.url).pathname;
const driverModules = /from ['"](pg|mysql2(\/[^'"]*)?|node:sqlite)['"]|import\(['"](pg|mysql2(\/[^'"]*)?|node:sqlite)['"]\)/;

function declarationFiles(directory) {
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...declarationFiles(path));
    else if (entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

await runCase('package-declarations/no-driver-imports', 60_000, async () => {
  const offending = declarationFiles(join(client, 'dist')).filter(file => driverModules.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offending.map(file => file.slice(client.length)), [], 'declaration files that import a driver module');
});

await runCase('package-declarations/type-check-without-driver-types', 120_000, async () => {
  const work = mkdtempSync(join(tmpdir(), 'orm-package-declarations-'));
  try {
    const packed = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], { cwd: client, encoding: 'utf8' });
    const [{ filename, name }] = JSON.parse(packed);
    const project = join(work, 'project');
    const installed = join(project, 'node_modules', ...name.split('/'));
    mkdirSync(installed, { recursive: true });
    execFileSync('tar', ['-xzf', join(work, filename), '-C', installed, '--strip-components', '1']);
    cpSync(join(client, 'node_modules', 'ordered-json'), join(project, 'node_modules', 'ordered-json'), { recursive: true });
    for (const types of [['@types', 'node'], ['undici-types']]) {
      cpSync(join(client, 'node_modules', ...types), join(project, 'node_modules', ...types), { recursive: true });
    }
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'project', private: true, type: 'module' }));
    writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false, types: ['node'] },
      files: ['index.ts'],
    }));
    writeFileSync(join(project, 'index.ts'), [
      `import { Db, introspectDbspec, type DbspecApplyMySqlConnection, type DbspecApplyPostgresConnection, type DbspecApplySqliteConnection, type DbspecMySqlConnection, type DbspecPostgresConnection, type DbspecSqliteConnection } from '${name}';`,
      'export async function use(db: Db, mysql: DbspecMySqlConnection, postgres: DbspecPostgresConnection, sqlite: DbspecSqliteConnection): Promise<void> {',
      "  await introspectDbspec(mysql, 'mysql', 'example');",
      "  await introspectDbspec(postgres, 'postgres', 'example');",
      "  await introspectDbspec(sqlite, 'sqlite', 'example');",
      '  await db.close();',
      '}',
      'export type ApplyConnections = [DbspecApplyMySqlConnection, DbspecApplyPostgresConnection, DbspecApplySqliteConnection];',
      '',
    ].join('\n'));
    const tsc = spawnSync(process.execPath, [join(client, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', project], { encoding: 'utf8' });
    assert.equal(tsc.status, 0, `tsc of the project failed:\n${tsc.stdout}${tsc.stderr}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
