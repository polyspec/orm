// resources는 실행의 자원을 30초마다 한 줄 묶음으로 stdout에 쓴다: memory(free -m), /와 /tmp의 공간(df -h), RSS가 큰
// process 다섯(pid, process group, RSS, 명령), 그리고 그 사이에 단계의 process group에 보낸 signal. CI의 runner가 job
// 도중에 사라지면 보고서와 artifact는 올라가지 않지만 흘려 보낸 job log는 남으므로, 이 줄이 그 순간까지의 자원을 보인다.
import { spawnSync } from 'node:child_process';
import { signals } from './step.mjs';

const run = (program, args) => {
  const result = spawnSync(program, args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

// topProcesses는 RSS가 큰 process를 count개 돌려준다: [{ pid, pgid, rssMiB, command }].
export function topProcesses(listing, count = 5) {
  return listing.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map(([, pid, pgid, rss, command]) => ({ pid: Number(pid), pgid: Number(pgid), rssMiB: Math.round(Number(rss) / 1024), command: command.trim() }))
    .sort((a, b) => b.rssMiB - a.rssMiB).slice(0, count);
}

// resourceLines는 지금의 자원 줄이다. 보낸 signal은 꺼내 비운다.
export function resourceLines(now = new Date()) {
  const memory = run('free', ['-m'])?.split('\n').find(line => line.startsWith('Mem:')) ?? 'free -m unavailable on this system';
  const disk = (run('df', ['-h', '/', '/tmp']) ?? 'df unavailable').split('\n').slice(1).map(line => line.replace(/\s+/g, ' ')).join('; ');
  const top = topProcesses(run('ps', ['-A', '-o', 'pid=,pgid=,rss=,comm=']) ?? '').map(({ pid, pgid, rssMiB, command }) => `${pid}/${pgid} ${rssMiB}MiB ${command}`).join('; ');
  const sent = signals.splice(0);
  return [
    `RESOURCES ${now.toISOString()} memory ${memory.replace(/\s+/g, ' ')}`,
    `RESOURCES disk ${disk}`,
    `RESOURCES top rss (pid/pgid) ${top}`,
    `RESOURCES group signals ${sent.length ? sent.join(', ') : 'none'}`,
  ];
}

// monitor는 intervalMs마다 resourceLines를 쓰고, 멈추는 함수를 돌려준다. timer는 process가 끝나는 것을 막지 않는다.
export function monitor(write = line => console.log(line), intervalMs = 30_000) {
  const tick = () => { for (const line of resourceLines()) write(line); };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
