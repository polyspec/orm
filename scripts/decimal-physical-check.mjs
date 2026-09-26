// Execute every generated decimal model owner twice against each isolated database.
import { spawn } from 'node:child_process';

const databases = ['mysql', 'postgres', 'sqlite'];
const languages = ['go', 'php', 'rust', 'typescript'];
const timeoutMs = 120_000;

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
    return ['go', ['test', '-json', './clients/go/decimalmodel', '-run', `^TestDecimalPhysical${suffix}$`, '-count=1', '-timeout', '45s']];
  }
  if (language === 'php') return ['php', ['clients/php/tests/decimal_model_db.php', '--dialect', database]];
  if (language === 'rust') {
    return ['cargo', ['test', '--offline', '--locked', '--manifest-path', 'clients/rust/Cargo.toml', '-p', 'orm-tests', '--bin', 'decimal_physical', id, '--', '--exact']];
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

await run('node', ['clients/typescript/dist/bin/orm-gen.js', 'gen', '--schema', 'contracts/fixtures/decimal_schema.json',
  '--out', 'clients/typescript/src/models/decimal_fixture', '--scan', 'clients/typescript/tests/decimal_model_db.mjs', '--check']);
for (const database of databases) {
  const key = `DECIMAL_${database.toUpperCase()}_DSN`;
  const dsn = process.env[key];
  if (!dsn) throw new Error(`${key} is required`);
  const before = await state(database, dsn);
  for (const language of languages) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const [program, args] = command(language, database);
      const output = await run(program, args);
      if (!observed(language, database, output)) throw new Error(`${database}/${language}/${attempt}: missing exact pass event`);
      const after = await state(database, dsn);
      if (after !== before) throw new Error(`${database}/${language}/${attempt}: database state changed`);
      console.log(`PASS ${database} ${language} ${attempt} state=${after}`);
    }
  }
}
