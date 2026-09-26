// Run PHP and TypeScript grouped-result owners twice on each database.
import { spawn } from 'node:child_process';

const databases = ['mysql', 'postgres', 'sqlite'];
const timeoutMs = 120_000;

function run(program, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env, detached: true });
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

async function state(database, dsn) {
  let output;
  try { output = await run('go', ['run', './tests/conformance/check', 'state', '-driver', database, '-dsn', dsn]); }
  catch (error) { throw new Error(String(error).replaceAll(dsn, '[redacted]')); }
  const match = new RegExp(`^${database} state ([a-f0-9]{64})\\n$`).exec(output);
  if (!match) throw new Error(`${database}: invalid state reader output`);
  return match[1];
}

for (const database of databases) {
  const key = `BENCH_${database.toUpperCase()}_DSN`;
  const dsn = process.env[key];
  if (!dsn) throw new Error(`${key} is required`);
  const before = await state(database, dsn);
  for (const language of ['php', 'typescript']) {
    const program = language === 'php' ? 'php' : 'node';
    const path = `clients/${language}/tests/group_rows_db.${language === 'php' ? 'php' : 'mjs'}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const output = await run(program, [path], { ...process.env, ORM_GROUP_DATABASE: database, ORM_GROUP_DSN: dsn });
      if (output.trim() !== `CASE group_rows_${database} PASS`) {
        throw new Error(`${database}/${language}/${attempt}: missing exact pass event`);
      }
      const after = await state(database, dsn);
      if (after !== before) throw new Error(`${database}/${language}/${attempt}: database state changed`);
      console.log(`PASS ${database} ${language} ${attempt} state=${after}`);
    }
  }
}
