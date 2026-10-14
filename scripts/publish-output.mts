// publish-output.mts <output> <command> [args...]
//
// 다른 실행이나 뒤의 단계가 읽는 build 출력 file <output>을 원자적으로 publish한다. 명령은 같은 directory의 임시
// file <output>.next-<pid>에 쓰고, 성공하면 rename으로 <output>을 바꾼다. 그래서 <output>을 읽는 쪽은 이전 file
// 전체나 새 file 전체만 보고, 중간에 끊긴 build가 남긴 반쪽 file을 보지 않는다. 인자 가운데 @OUT@은 임시 file의
// 경로로 바뀌고(go build -o @OUT@), @OUT@이 없으면 명령의 표준 출력이 임시 file이 된다. 실패한 명령의 임시 file은
// 지우고 <output>은 그대로 둔다.
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
