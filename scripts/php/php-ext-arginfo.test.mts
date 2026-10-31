// The interrupt case of the arginfo writer (CR3, B1-4): a write of the header that is cut off leaves the previous header whole.
// The new header comes through a named pipe whose writer sends its first bytes and then holds the pipe open, so the publish is
// stopped in the middle of the copy, the way an interrupted run stops it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, PROCESS } from '../../tests/testcase.mts';

const module = new URL('./php-ext-arginfo.mts', import.meta.url).pathname;

caseTest('an interrupted arginfo write leaves the previous header whole', PROCESS, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orm-arginfo-interrupt-'));
  const writer = { child: undefined as ReturnType<typeof spawn> | undefined };
  try {
    const pipe = join(dir, 'generated.pipe');
    const destination = join(dir, 'polyspec_orm_arginfo.h');
    writeFileSync(destination, 'OLD HEADER\n');
    assert.equal(spawnSync('mkfifo', [pipe]).status, 0, 'mkfifo makes the pipe that stands for the generated header');
    // The writer opens the pipe (it waits for a reader), sends the first bytes of the new header, and keeps the pipe open.
    writer.child = spawn('sh', ['-c', `exec 3> "${pipe}"; printf 'NEW HEADER\\n' >&3; sleep 60`], { stdio: 'ignore' });
    const reader = spawn(process.execPath, ['--input-type=module', '-e',
      `const { publishHeader } = await import(${JSON.stringify(module)}); await publishHeader(${JSON.stringify(pipe)}, ${JSON.stringify(destination)});`],
    { stdio: 'ignore' });
    const exited = new Promise(resolve => reader.once('exit', resolve));
    await new Promise(resolve => setTimeout(resolve, 1500));
    reader.kill('SIGKILL');
    await exited;
    assert.equal(readFileSync(destination, 'utf8'), 'OLD HEADER\n', 'the interrupted write changed the previous header; it must stay whole');
  } finally {
    writer.child?.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
