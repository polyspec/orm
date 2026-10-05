#!/usr/bin/env python3
# stop-process.py <signal> <pid>는 process 하나에 signal을 보내고 그 process가 끝나는 사건을 운영체제에서
# 받아 돌아온다. polling도 기한도 없다: 서버 정지는 장기 작업이고, 끝났는지는 운영체제가 알리는 종료로
# 판정한다. macOS(BSD)는 kqueue의 EVFILT_PROC NOTE_EXIT, Linux는 pidfd(os.pidfd_open)를 poll한다.
# 감시를 먼저 등록한 뒤 signal을 보내므로 그 사이에 끝난 process도 놓치지 않는다. 등록할 때 이미
# 없는 process는 끝난 것으로 보고하고 0으로 끝난다.
import os
import select
import signal
import sys


def watcher(pid):
    # watcher는 process 종료를 기다리는 함수를 돌려준다. 이미 없는 process면 None이다.
    if hasattr(select, 'kqueue'):
        queue = select.kqueue()
        event = select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                              fflags=select.KQ_NOTE_EXIT)
        try:
            queue.control([event], 0)
        except ProcessLookupError:
            return None
        return lambda: queue.control(None, 1)
    try:
        descriptor = os.pidfd_open(pid)
    except ProcessLookupError:
        return None
    poller = select.poll()
    poller.register(descriptor, select.POLLIN)
    return lambda: poller.poll()


def main():
    if len(sys.argv) != 3 or not sys.argv[2].isdigit():
        print('usage: stop-process.py <signal> <pid>', file=sys.stderr)
        return 2
    name = sys.argv[1].upper()
    number = getattr(signal, name if name.startswith('SIG') else 'SIG' + name, None)
    if not isinstance(number, signal.Signals):
        print(f'stop-process: unknown signal {sys.argv[1]}', file=sys.stderr)
        return 2
    pid = int(sys.argv[2])
    wait = watcher(pid)
    if wait is None:
        print(f'stop-process: process {pid} had already exited')
        return 0
    try:
        os.kill(pid, number)
    except ProcessLookupError:
        pass
    wait()
    return 0


if __name__ == '__main__':
    sys.exit(main())
