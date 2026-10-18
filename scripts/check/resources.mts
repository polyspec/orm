// resources writes the run's resources to stdout every 30 seconds as one block of lines: memory (free -m), space on / and /tmp (df -h), and the processes with large RSS
// (five of them: pid, process group, RSS, command), and the signals sent to a step's process group in between. If the CI runner's job
// disappears midway, the report and artifacts are not uploaded, but the streamed job log remains, so these lines show the resources up to that moment.
import { spawnSync } from 'node:child_process';
import { signals } from './step.mts';

const run = (program: string, args: string[]) => {
  const result = spawnSync(program, args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

// topProcesses returns count processes with the largest RSS: [{ pid, pgid, rssMiB, command }].
export function topProcesses(listing: string, count = 5): { pid: number; pgid: number; rssMiB: number; command: string }[] {
  return listing.split('\n').map((line: string) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(match => match !== null)
    .map(([, pid, pgid, rss, command = '']) => ({ pid: Number(pid), pgid: Number(pgid), rssMiB: Math.round(Number(rss) / 1024), command: command.trim() }))
    .sort((a, b) => b.rssMiB - a.rssMiB).slice(0, count);
}

// resourceLines are the current resource lines. The signals sent are taken out and cleared.
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

// monitor writes resourceLines every intervalMs and returns a function that stops it. The timer does not keep the process from exiting.
export function monitor(write = (line: string) => console.log(line), intervalMs = 30_000) {
  const tick = () => { for (const line of resourceLines()) write(line); };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
