// Execute every generated decimal model owner twice against each isolated database.
import { spawn } from 'node:child_process';
import { runCase } from '../tests/testcase.mjs';

const databases = ['mysql', 'postgres', 'sqlite'];
const languages = ['go', 'php', 'rust', 'typescript'];
// timeoutMs는 process 하나(owner test, orm-gen, state reader)의 기한이다.
const timeoutMs = 120_000;

// 한 실행은 owner process 하나와 state reader process 하나이므로 그 기한은 둘의 timeoutMs를
// 더한 것이다. 실패한 case는 이유와 함께 보고되고 check는 거기서 끝난다.
async function step(name, deadline, body) {
  if (!(await runCase(name, deadline, body))) process.exit(1);
}

function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env: process.env, detached: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
      finish(new Error(`${program} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    }
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', finish);
    child.on('close', code => finish(code === 0 ? null : new Error(`${program} exit ${code}: ${stderr || stdout}`)));
  });
}

function command(language, database) {
  const id = `decimal_${database}`;
  if (language === 'go') {
    const suffix = database === 'postgres' ? 'Postgres' : database === 'mysql' ? 'MySQL' : 'SQLite';
    return ['go', ['test', '-json', '-tags', 'decimalphysical', './clients/go/decimalmodel', '-run', `^TestDecimalPhysical${suffix}$`, '-count=1', '-timeout', '0']];
  }
  if (language === 'php') return ['php', ['clients/php/tests/decimal_model_db.php', '--dialect', database]];
  if (language === 'rust') {
    return ['cargo', ['test', '--offline', '--locked', '--manifest-path', 'clients/rust/Cargo.toml', '-p', 'orm-tests', '--bin', 'decimal_physical', id, '--', '--exact', '--include-ignored']];
  }
  return ['node', ['clients/typescript/tests/decimal_model_db.mjs', '--dialect', database]];
}

function observed(language, database, output) {
  const id = `decimal_${database}`;
  if (language === 'go') {
    const suffix = database === 'postgres' ? 'Postgres' : database === 'mysql' ? 'MySQL' : 'SQLite';
    const events = output.trim().split('\n').map(line => JSON.parse(line));
    return events.filter(event => event.Action === 'pass' && event.Test === `TestDecimalPhysical${suffix}`).length === 1 &&
      events.some(event => event.Action === 'pass' && !event.Test);
  }
  if (language === 'rust') return output.includes(`test ${id} ... ok`) && output.includes('1 passed; 0 failed');
  return output.trim() === `CASE ${id} PASS`;
}

async function state(database, dsn) {
  let output;
  try { output = await run('go', ['run', './tests/conformance/check', 'state', '-driver', database, '-dsn', dsn]); }
  catch (error) { throw new Error(String(error).replaceAll(dsn, '[redacted]')); }
  const match = new RegExp(`^${database} state ([a-f0-9]{64})\\n$`).exec(output);
  if (!match) throw new Error(`${database}: invalid state reader output`);
  return match[1];
}

await step('decimal/models', timeoutMs, () => run('node', ['clients/typescript/dist/bin/orm-gen.js', 'gen', '--schema', 'contracts/fixtures/decimal_schema.dbs',
  '--out', 'clients/typescript/src/models/decimal_fixture', '--scan', 'clients/typescript/tests/decimal_model_db.mjs', '--check']));
for (const database of databases) {
  const key = `DECIMAL_${database.toUpperCase()}_DSN`;
  const dsn = process.env[key];
  if (!dsn) throw new Error(`${key} is required`);
  let before;
  await step(`decimal/${database}/state`, timeoutMs, async ({ step: progress }) => {
    before = await state(database, dsn);
    progress(`state ${before}`);
  });
  for (const language of languages) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await step(`decimal/${database}/${language}/${attempt}`, 2 * timeoutMs, async ({ step: progress }) => {
        const [program, args] = command(language, database);
        let output;
        try { output = await run(program, args); }
        catch (error) { throw new Error(String(error.message).replaceAll(dsn, '[redacted]')); }
        if (!observed(language, database, output)) throw new Error(`${database}/${language}/${attempt}: missing exact pass event`);
        const after = await state(database, dsn);
        if (after !== before) throw new Error(`${database}/${language}/${attempt}: database state changed`);
        progress(`state ${after}`);
      });
    }
  }
}
