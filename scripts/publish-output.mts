// publish-output.mts <output> <command> [args...]
//
// Atomically publishes the build output file <output> that another run or a later step reads. The command writes to a temporary
// file <output>.next-<pid> in the same directory, and on success rename replaces <output>. So readers of <output> see only the previous file
// in full or the new file in full, never a half file left by a build that was cut off. @OUT@ among the arguments is replaced by the path
// of the temporary file (go build -o @OUT@); if there is no @OUT@, the command's standard output becomes the temporary file. On a failed command, the temporary file is
// removed and <output> is left as it was.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

const [output, program, ...args] = process.argv.slice(2);
if (output === undefined || program === undefined) {
  console.error('usage: publish-output.mts <output> <command> [args...]; name the output first, then the command that writes it');
  process.exit(2);
}
const next = `${output}.next-${process.pid}`;
mkdirSync(dirname(output), { recursive: true });
const discard = () => rmSync(next, { force: true });
// A stop of the publish leaves no temporary file; the child of the same process group receives the signal itself.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => { discard(); process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1)); });

const replaced = args.includes('@OUT@');
const child = spawn(program, args.map(arg => (arg === '@OUT@' ? next : arg)), { stdio: ['inherit', replaced ? 'inherit' : 'pipe', 'inherit'] });
if (!replaced) child.stdout?.pipe(createWriteStream(next));
const code = await new Promise<number>(resolve => {
  child.on('error', error => { console.error(`publish-output: ${program}: ${error.message}`); resolve(127); });
  child.on('close', (status, signal) => resolve(status ?? (signal === null ? 1 : 128)));
});
if (code !== 0) {
  discard();
  process.exit(code);
}
if (!existsSync(next)) {
  console.error(`publish-output: ${[program, ...args].join(' ')} wrote no ${next}; the command must write the file that @OUT@ names`);
  process.exit(1);
}
renameSync(next, output);
