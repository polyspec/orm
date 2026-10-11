# markdown IR executor의 DSN, connect와 control message, error 줄, 거절하는 surface (docs/protocol.md §5,
# docs/dialects.md "Markdown IR executor"). flowmark server 대신 한 연결의 message를 적는 fake server를 쓴다.
import queue
import socket
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.database import Db, parse_dsn  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402
from polyspec.orm.markdown import MarkdownDsn  # noqa: E402

TOKEN = '0123456789abcdef0123456789abcdef'
CONNECT_LINE = '{"op":"connect","corpus":"tracker","token":"0123456789abcdef0123456789abcdef"}'


class FakeServer:
    """flowmark server 대신 한 연결의 message를 받아 적고 script의 답을 차례로 쓴다."""

    def __init__(self, test: unittest.TestCase, *answers: str):
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(('127.0.0.1', 0))
        self.listener.listen(1)
        self.received: queue.Queue = queue.Queue(1)
        self.thread = threading.Thread(target=self._serve, args=(answers,), daemon=True)
        self.thread.start()
        test.addCleanup(self.close)

    def _serve(self, answers) -> None:
        got: list = []
        try:
            conn, _ = self.listener.accept()
        except OSError:
            self.received.put(None)
            return
        with conn, conn.makefile('rwb') as stream:
            for answer in answers:
                line = stream.readline()
                if not line:
                    break
                got.append(line.decode('utf-8').rstrip('\n'))
                stream.write(answer.encode('utf-8') + b'\n')
                stream.flush()
        self.received.put(got)

    def dsn(self) -> str:
        host, port = self.listener.getsockname()
        return f'markdown://{host}:{port}/tracker?token={TOKEN}'

    def messages(self) -> list:
        # 한 case의 deadline이다: fake server가 script를 끝내지 못하면 case가 실패한다.
        return self.received.get(timeout=10)

    def close(self) -> None:
        self.listener.close()
        self.thread.join(10)


def raised(run):
    try:
        run()
    except BaseException as error:  # noqa: BLE001
        return error
    return None


class MarkdownTest(unittest.TestCase):
    def setUp(self):
        self.started = time.monotonic()
        print(f'RUN  markdown/{self._testMethodName}', flush=True)

    def tearDown(self):
        print(f'END  markdown/{self._testMethodName} elapsed={time.monotonic() - self.started:.3f}s', flush=True)

    def test_parse_markdown_dsn(self):
        parsed = parse_dsn(f'markdown://127.0.0.1:4100/tracker?token={TOKEN}')
        self.assertEqual(parsed.driver, 'markdown')
        self.assertEqual(parsed.zone, '+00:00')
        self.assertEqual(parsed.markdown, MarkdownDsn('127.0.0.1:4100', 'tracker', TOKEN))
        for dsn in ('markdown://127.0.0.1:4100/tracker',
                    'markdown://127.0.0.1:4100/tracker?token=',
                    'markdown://127.0.0.1:4100/tracker?token=a&token=b',
                    'markdown://127.0.0.1:4100/tracker?token=a&mode=ro',
                    'markdown://127.0.0.1/tracker?token=a',
                    'markdown://127.0.0.1:0/tracker?token=a',
                    'markdown://127.0.0.1:port/tracker?token=a',
                    'markdown://localhost:4100/tracker?token=a',
                    'markdown://10.0.0.1:4100/tracker?token=a',
                    'markdown://user@127.0.0.1:4100/tracker?token=a',
                    'markdown://127.0.0.1:4100/?token=a',
                    'markdown://127.0.0.1:4100/a/b?token=a'):
            error = raised(lambda: parse_dsn(dsn))
            self.assertIsInstance(error, OrmError, dsn)
            self.assertEqual(error.code, 'CONFIG', f'{dsn}: {error}')

    def test_markdown_session_messages(self):
        server = FakeServer(self, '{"ok":true}',
                            '{"ok":true}', '{"ok":true}', '{"ok":true}', '{"ok":true}',
                            '{"ok":true}',
                            '{"error":{"code":"WRITE_CONFLICT","message":"people.flowmark.md:3 changed since it '
                            'was read"}}')
        db = Db.connect(server.dsn())
        self.addCleanup(db.close)
        db.transaction(lambda: db.transaction(lambda: None), {'readOnly': True})
        error = raised(lambda: db.transaction(lambda: None))
        self.assertIsInstance(error, OrmError)
        self.assertEqual(error.code, 'WRITE_CONFLICT')
        self.assertEqual(str(error), 'WRITE_CONFLICT: people.flowmark.md:3 changed since it was read')
        db.close()
        self.assertEqual(server.messages(), [
            CONNECT_LINE,
            '{"op":"begin","read_only":true}',
            '{"op":"savepoint","name":"orm_sp_1"}',
            '{"op":"release","name":"orm_sp_1"}',
            '{"op":"commit"}',
            '{"op":"begin"}',
            '{"op":"commit"}',
        ])

    def test_markdown_connect_refused(self):
        server = FakeServer(self, '{"error":{"code":"CONFIG","message":"connect: the token is not the corpus\'s '
                                  'token"}}')
        error = raised(lambda: Db.connect(server.dsn()).close())
        self.assertIsInstance(error, OrmError)
        self.assertEqual(error.code, 'CONFIG')
        self.assertEqual(str(error), "CONFIG: connect: the token is not the corpus's token")
        self.assertEqual(server.messages(), [CONNECT_LINE])

    def test_markdown_rejected_surfaces(self):
        server = FakeServer(self, '{"ok":true}')
        db = Db.connect(server.dsn())
        self.addCleanup(db.close)
        for name, run in {
            'isolation': lambda: db.transaction(lambda: None, {'isolation': 'serializable'}),
            'timeoutMs': lambda: db.transaction(lambda: None, {'timeoutMs': 100}),
            'lock': lambda: db.utils().lock('k'),
            'setLocal': lambda: db.utils().set_local('k', 'v'),
            'subscribe': lambda: db.subscribe(lambda event: None),
        }.items():
            error = raised(run)
            self.assertIsInstance(error, OrmError, name)
            self.assertEqual(error.code, 'CAPABILITY_UNSUPPORTED', f'{name}: {error}')


if __name__ == '__main__':
    unittest.main()
