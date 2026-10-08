// Run PHP and TypeScript grouped-result owners twice on each database.
import { spawn } from 'node:child_process';
import { endGroup } from './check/step.mjs';
import { packageDirectory } from './features/packages.mjs';
import { runCase } from '../tests/testcase.mjs';

const databases = ['mysql', 'postgres', 'sqlite'];
// timeoutMs는 process 하나(owner test나 state reader)의 기한이다.
const timeoutMs = 120_000;

// 한 실행은 owner process 하나와 state reader process 하나이므로 그 기한은 둘의 timeoutMs를
// 더한 것이다. 실패한 case는 이유와 함께 보고되고 check는 거기서 끝난다.
async function step(name, deadline, body) {
  if (!(await runCase(name, deadline, body))) process.exit(1);
}

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
    // child는 자기 group의 leader다. 끝난 뒤 그 group에 남은 process는 실패로 다룬다(endGroup).
    const ended = new Promise(resolve => child.on('exit', () => endGroup(child.pid).then(resolve, error => resolve([`its group could not be checked: ${error.message}`]))));
    child.on('close', code => ended.then(left => finish(left.length ? new Error(`${program} left ${left.length} processes: ${left.join(', ')}`)
      : code === 0 ? null : new Error(`${program} exit ${code}: ${stderr || stdout}`))));
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
  if (!dsn) throw new Error(`${key} is required; run the test through its make target, which reads the environment of make test-servers`);
  let before;
  await step(`group-rows/${database}/state`, timeoutMs, async ({ step: progress }) => {
    before = await state(database, dsn);
    progress(`state ${before}`);
  });
  for (const language of ['php', 'typescript']) {
    const program = language === 'php' ? 'php' : 'node';
    const path = `${packageDirectory[language]}/tests/group_rows_db.${language === 'php' ? 'php' : 'mjs'}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      await step(`group-rows/${database}/${language}/${attempt}`, 2 * timeoutMs, async ({ step: progress }) => {
        let output;
        try { output = await run(program, [path], { ...process.env, ORM_GROUP_DATABASE: database, ORM_GROUP_DSN: dsn }); }
        catch (error) { throw new Error(String(error.message).replaceAll(dsn, '[redacted]')); }
        if (output.trim() !== `CASE group_rows_${database} PASS`) {
          throw new Error(`${database}/${language}/${attempt}: missing exact pass event`);
        }
        const after = await state(database, dsn);
        if (after !== before) throw new Error(`${database}/${language}/${attempt}: database state changed`);
        progress(`state ${after}`);
      });
    }
  }
}
