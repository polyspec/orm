// Asks the process groups of the programs that the interface checker started to end when the checker ends, whichever way it
// ends. A signal handler of the checker cannot do this: SIGKILL runs none. The checker holds the write end of this process's
// standard input, and the system closes it when the checker ends, so the end of the input is the event.
// A line is `+<pid>`, a group that started, or `-<pid>`, a group that ended.
//
// The request is SIGTERM (stopGroup of scripts/check/step.mts, FCV-18). This process owns no output of those groups, so it
// has no event for their end: it sends the request, names the processes that it asked and those that are still alive, and
// ends. It sends no SIGKILL.
import { createInterface } from 'node:readline';
import { errorMessage } from '../../errors.mts';
import { stopGroup } from '../../../scripts/check/step.mts';

const groups = new Set<number>();
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const pid = Number(line.slice(1));
  if (line.startsWith('+')) groups.add(pid);
  else groups.delete(pid);
});
lines.on('close', () => {
  void Promise.allSettled([...groups].map(group => stopGroup(group, Promise.resolve(), line => { console.error(line); }))).then(results => {
    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value.length) console.error(`interface check: still alive after SIGTERM: ${result.value.join(', ')}`);
        continue;
      }
      console.error(`interface check: a group of the ended checker could not be stopped: ${errorMessage(result.reason)}`);
      process.exitCode = 1;
    }
  });
});
