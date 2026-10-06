// The published declarations type-check in a project that has none of the driver types.
// The case packs the package with npm pack, installs the tarball's files and its declared
// type dependency ordered-json into a temporary project, adds @types/node with its
// undici-types (a Node project has them) but neither pg, @types/pg nor mysql2, and runs tsc with skipLibCheck
// off over a source that imports the public API, the dbspec apply and introspection
// declarations included. A declaration that names a driver module fails with TS2307 or
// TS7016. The case also rejects a declaration file that imports pg, mysql2 or
// node:sqlite, so the declarations type-check with the MySQL or SQLite driver alone.
// Packing, installing and tsc are long operations: they run through runLong with their
// output as step lines and no deadline, and the cases check what they produced.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPUTE, runCase, runLong, stepLines } from '../../../tests/testcase.mjs';

const client = new URL('..', import.meta.url).pathname;
// command는 program을 실행하고 출력 줄을 step으로 내보내며 종료 코드와 출력을 돌려준다.
function command(program, args, options, step) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = stepLines(step);
    let stdout = '';
    let output = '';
    child.stdout.on('data', chunk => { stdout += chunk; output += chunk; lines.write(String(chunk)); });
    child.stderr.on('data', chunk => { output += chunk; lines.write(String(chunk)); });
    child.on('error', reject);
    child.on('close', code => {
      lines.flush();
      step(`exit ${code}`);
      resolve({ code, stdout, output });
    });
  });
}

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

let failed = 0;
const check = async (name, deadline, body) => { if (!(await runCase(name, deadline, body))) failed++; };

await check('package-declarations/no-driver-imports', COMPUTE, async () => {
  const offending = declarationFiles(join(client, 'dist')).filter(file => driverModules.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offending.map(file => file.slice(client.length)), [], 'declaration files that import a driver module');
});

const work = mkdtempSync(join(tmpdir(), 'orm-package-declarations-'));
const project = join(work, 'project');
let tsc;
try {
  let name;
  const installed = await runLong('package-declarations/install', async ({ step }) => {
    const packed = await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], { cwd: client }, step);
    if (packed.code !== 0) throw new Error(`npm pack exited with ${packed.code}`);
    const [{ filename, name: packageName }] = JSON.parse(packed.stdout);
    name = packageName;
    const target = join(project, 'node_modules', ...name.split('/'));
    mkdirSync(target, { recursive: true });
    const tar = await command('tar', ['-xzf', join(work, filename), '-C', target, '--strip-components', '1'], {}, step);
    if (tar.code !== 0) throw new Error(`tar exited with ${tar.code}`);
    cpSync(join(client, 'node_modules', '@polyspec', 'ordered-json'), join(project, 'node_modules', '@polyspec', 'ordered-json'), { recursive: true });
    for (const types of [['@types', 'node'], ['undici-types']]) {
      cpSync(join(client, 'node_modules', ...types), join(project, 'node_modules', ...types), { recursive: true });
    }
    step(`installed ${name}, ordered-json, @types/node and undici-types into ${project}`);
  });
  if (installed) {
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
    // tsc의 종료 코드와 출력은 아래 case가 판정한다. runLong은 tsc가 끝나기까지 기다리기만 한다.
    await runLong('package-declarations/tsc', async ({ step }) => {
      tsc = await command(process.execPath, [join(client, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', project], {}, step);
    });
  } else failed++;
  await check('package-declarations/type-check-without-driver-types', COMPUTE, () => {
    assert.ok(tsc, 'tsc of the project did not run');
    assert.equal(tsc.code, 0, `tsc of the project failed:\n${tsc.output}`);
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (failed) {
  console.log(`${failed} case(s) failed`);
  process.exitCode = 1;
}
