// Ends the process groups of the programs that the interface checker started when the checker ends, whichever way it ends. A signal
// handler cannot do this: SIGKILL runs none, and a test helper that reaches its deadline sends SIGKILL. The checker holds the write end
// of this process's standard input, and the system closes it when the checker ends, so the end of the input is the event.
// A line is `+<pid>`, a group that started, or `-<pid>`, a group that ended.
import { createInterface } from 'node:readline';
import { errorCode } from '../../errors.mts';

const groups = new Set<number>();
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const pid = Number(line.slice(1));
  if (line.startsWith('+')) groups.add(pid);
  else groups.delete(pid);
});
lines.on('close', () => {
  for (const pid of groups) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      // The group ended after its last line was written.
      if (errorCode(error) !== 'ESRCH') throw error;
    }
  }
});
