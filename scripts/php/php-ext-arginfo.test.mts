// The interrupt case of the arginfo writer (CR3, B1-4): a write of the header that is cut off leaves the previous header whole.
// The new header comes through a named pipe whose writer sends its first bytes and then holds the pipe open, so the publish is
// stopped in the middle of the copy, the way an interrupted run stops it.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest } from '../../tests/testcase.mts';

const module = new URL('./php-ext-arginfo.mts', import.meta.url).pathname;

// untilPublishStarts resolves when the publish has begun writing: the directory gains an entry (the temporary copy) or the
// destination changes. It is driven by the file system's notifications, not by a timer, and it rejects if the publish exits first.
function untilPublishStarts(dir: string, destination: string, reader: ChildProcess): Promise<void> {
  const listing = readdirSync(dir).sort().join('\n');
  const previous = readFileSync(destination, 'utf8');
  const started = (): boolean => readdirSync(dir).sort().join('\n') !== listing || readFileSync(destination, 'utf8') !== previous;
  return new Promise((resolve, reject) => {
    const watchers: FSWatcher[] = [];
    const finish = (settle: () => void): void => {
      for (const watcher of watchers) watcher.close();
      settle();
    };
    const check = (): void => {
      if (started()) finish(resolve);
    };
    watchers.push(watch(dir, check), watch(destination, check));
    reader.once('exit', () => finish(() => reject(new Error('the publish exited before it started writing'))));
    check();
  });
}

caseTest('an interrupted arginfo write leaves the previous header whole', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orm-arginfo-interrupt-'));
  const writer = { child: undefined as ReturnType<typeof spawn> | undefined };
  try {
    const pipe = join(dir, 'generated.pipe');
    const destination = join(dir, 'polyspec_orm_arginfo.h');
    writeFileSync(destination, 'OLD HEADER\n');
    assert.equal(spawnSync('mkfifo', [pipe]).status, 0, 'mkfifo makes the pipe that stands for the generated header');
    // The writer opens the pipe (it waits for a reader), sends the first bytes of the new header, and keeps the pipe open.
    writer.child = spawn('sh', ['-c', `exec 3> "${pipe}"; printf 'NEW HEADER\\n' >&3; exec sleep 60`], { stdio: 'ignore' });
    const reader = spawn(process.execPath, ['--input-type=module', '-e',
      `const { publishHeader } = await import(${JSON.stringify(module)}); await publishHeader(${JSON.stringify(pipe)}, ${JSON.stringify(destination)});`],
    { stdio: 'ignore' });
    const exited = new Promise(resolve => reader.once('exit', resolve));
    await untilPublishStarts(dir, destination, reader);
    reader.kill('SIGKILL');
    await exited;
    assert.equal(readFileSync(destination, 'utf8'), 'OLD HEADER\n', 'the interrupted write changed the previous header; it must stay whole');
  } finally {
    writer.child?.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
