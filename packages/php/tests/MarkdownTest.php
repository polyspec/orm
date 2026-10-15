<?php
declare(strict_types=1);

/*
 * markdown IR executor의 unit case다(docs/protocol.md §5): markdown DSN, client가 보내는 connect와
 * control message와 error 줄의 해석, server가 거절한 connect, markdown 연결이 거절하는 SQL 전용
 * surface, 그리고 message encoder가 parameter마다 slot의 form을 읽는 Validator::paramUses다.
 * 한 class의 크기는 가장 큰 case(하위 process)의 Large다.
 * flowmark server 대신 markdown_fake_server.php가 한 연결의 message를 받아 적고 정한 답을 쓴다.
 */

require_once dirname(__DIR__) . '/markdownmodel/bootstrap.php';

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Validator;

const MARKDOWN_TOKEN = '0123456789abcdef0123456789abcdef';
const MARKDOWN_CONNECT_LINE = '{"op":"connect","corpus":"tracker","token":"' . MARKDOWN_TOKEN . '"}';

/** 오류 code다. 던지지 않으면 null이다. */
function markdown_error(Closure $fn): ?OrmException
{
    try {
        $fn();
    } catch (OrmException $e) {
        return $e;
    }
    return null;
}

/**
 * markdown_fake_server.php를 $answers로 시작한다. 돌려주는 값은 [process, stdout, dsn, stderr]이다.
 * stderr는 pipe로 받는다: 이 process의 STDERR를 넘기면 file로 redirect한 출력의 앞부분이 사라진다.
 *
 * @param list<string> $answers
 * @return array{0: resource, 1: resource, 2: string, 3: resource}
 */
function markdown_fake_server(array $answers): array
{
    $process = proc_open([PHP_BINARY, __DIR__ . '/markdown_fake_server.php', ...$answers], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if ($process === false) {
        throw new RuntimeException('cannot start markdown_fake_server.php');
    }
    $port = trim((string) fgets($pipes[1]));
    if (preg_match('/^[0-9]+$/', $port) !== 1) {
        $stderr = (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($process);
        throw new RuntimeException("markdown_fake_server.php printed \"$port\", not its port; stderr:\n$stderr");
    }
    return [$process, $pipes[1], "markdown://127.0.0.1:$port/tracker?token=" . MARKDOWN_TOKEN, $pipes[2]];
}

/**
 * fake server가 받은 message 줄이다. server가 끝나기를 기다린다.
 *
 * @param array{0: resource, 1: resource, 2: string, 3: resource} $server
 * @return list<string>
 */
function markdown_received(array $server): array
{
    $line = (string) stream_get_contents($server[1]);
    $stderr = (string) stream_get_contents($server[3]);
    fclose($server[1]);
    fclose($server[3]);
    proc_close($server[0]);
    $received = json_decode($line, true);
    if (!is_array($received)) {
        throw new RuntimeException("markdown_fake_server.php printed \"$line\", not the received lines; stderr:\n$stderr");
    }
    return $received;
}

#[Large]
final class MarkdownTest extends TestCase
{
    public function test_parse_dsn(): void
    {
        $got = Orm::parseMarkdownDsn('markdown://127.0.0.1:4100/tracker?token=' . MARKDOWN_TOKEN);
        self::assertFalse($got !== ['127.0.0.1:4100', 'tracker', MARKDOWN_TOKEN], 'parseMarkdownDsn() = ' . json_encode($got));
        foreach ([
            'markdown://127.0.0.1:4100/tracker',
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
            'markdown://127.0.0.1:4100/a/b?token=a',
        ] as $input) {
            $e = markdown_error(static fn() => Orm::parseMarkdownDsn($input));
            self::assertFalse($e?->code_ !== Code::CONFIG, "parseMarkdownDsn($input) = " . ($e?->getMessage() ?? 'no error') . '; want CONFIG');
            $e = markdown_error(static fn() => Orm::connect($input, new Config()));
            self::assertFalse($e?->code_ !== Code::CONFIG, "connect($input) = " . ($e?->getMessage() ?? 'no error') . '; want CONFIG');
        }
    }

    public function test_session_messages(): void
    {
        $server = markdown_fake_server([
            '{"ok":true}',
            '{"ok":true}', '{"ok":true}', '{"ok":true}', '{"ok":true}',
            '{"ok":true}', '{"error":{"code":"WRITE_CONFLICT","message":"people.flowmark.md:3 changed since it was read"}}',
        ]);
        $db = Orm::connect($server[2], new Config());
        self::assertFalse($db->driver() !== 'markdown', "driver() = {$db->driver()}; want markdown");
        $db->transaction(static function () use ($db): void {
            $db->transaction(static function (): void {});
        }, readOnly: true);
        $e = markdown_error(static fn() => $db->transaction(static function (): void {}));
        self::assertFalse($e?->code_ !== Code::WRITE_CONFLICT || $e->getMessage() !== 'WRITE_CONFLICT: people.flowmark.md:3 changed since it was read', 'commit error = ' . ($e?->getMessage() ?? 'none') . "; want WRITE_CONFLICT with the server's message");
        $db->close();
        $want = [
            MARKDOWN_CONNECT_LINE,
            '{"op":"begin","read_only":true}',
            '{"op":"savepoint","name":"orm_sp_1"}',
            '{"op":"release","name":"orm_sp_1"}',
            '{"op":"commit"}',
            '{"op":"begin"}',
            '{"op":"commit"}',
        ];
        self::assertFalse(($got = markdown_received($server)) !== $want, "messages:\n" . implode("\n", $got) . "\nwant:\n" . implode("\n", $want));
    }

    public function test_connect_refused(): void
    {
        $server = markdown_fake_server(['{"error":{"code":"CONFIG","message":"connect: the token is not the corpus\'s token"}}']);
        $e = markdown_error(static fn() => Orm::connect($server[2], new Config())->close());
        self::assertFalse($e?->code_ !== Code::CONFIG || $e->getMessage() !== "CONFIG: connect: the token is not the corpus's token", 'connect error = ' . ($e?->getMessage() ?? 'none') . "; want the server's CONFIG");
        self::assertFalse(($got = markdown_received($server)) !== [MARKDOWN_CONNECT_LINE], 'messages = ' . json_encode($got));
    }

    public function test_rejected_surfaces(): void
    {
        $server = markdown_fake_server(['{"ok":true}']);
        $db = Orm::connect($server[2], new Config());
        $surfaces = [
            'isolation' => static fn() => $db->transaction(static function (): void {}, isolation: 'serializable'),
            'timeoutMs' => static fn() => $db->transaction(static function (): void {}, timeoutMs: 100),
            'audit' => static fn() => $db->transaction(static function (): void {}, audit: ['account' => 'a']),
            'lock' => static fn() => $db->utils()->lock('k'),
            'setLocal' => static fn() => $db->utils()->setLocal('k', 'v'),
            'local' => static fn() => $db->utils()->local('k'),
            'subscribe' => static fn() => $db->subscribe(static function (): void {}),
        ];
        foreach ($surfaces as $name => $fn) {
            $e = markdown_error($fn);
            self::assertFalse($e?->code_ !== Code::CAPABILITY_UNSUPPORTED, "$name: " . ($e?->getMessage() ?? 'no error') . '; want CAPABILITY_UNSUPPORTED');
        }
        $e = markdown_error(static fn() => Orm::connect($server[2], new Config(statementTimeoutMs: 100)));
        self::assertFalse($e?->code_ !== Code::CAPABILITY_UNSUPPORTED, 'statementTimeoutMs: ' . ($e?->getMessage() ?? 'no error') . '; want CAPABILITY_UNSUPPORTED');
        $db->close();
        markdown_received($server);
    }

    public function test_request_message(): void
    {
        // request message는 parameter를 slot의 form으로 쓴다: date column과 비교하는 시각은 YYYY-MM-DD다. 행이 없는
        // group count는 빈 결과다.
        $server = markdown_fake_server(['{"ok":true}', '{"rows":[]}']);
        $db = \Polyspec\Orm\Tests\MarkdownModel\connect($server[2], new Config());
        $groups = (new \Polyspec\Orm\Tests\MarkdownModel\Tasks())->connect($db)
            ->due(new DateTimeImmutable('2026-10-01 00:00:00', new DateTimeZone('UTC')))->groupByOwner()->getsCount()->toArray();
        self::assertFalse($groups !== [], 'group count of no rows = ' . json_encode($groups));
        $db->close();
        $received = markdown_received($server);
        $message = json_decode($received[1] ?? 'null', true);
        self::assertFalse(!is_array($message) || $message['params'] !== ['2026-10-01'] || $message['request']['kind'] !== 'group_count'
            || $message['ir_version'] !== 1 || $message['manifest_hash'] !== \Polyspec\Orm\Tests\MarkdownModel\MANIFEST_HASH
            || preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/D', (string) $message['now']) !== 1, 'request message = ' . ($received[1] ?? 'none'));
    }

    public function test_bind_message_vectors(): void
    {
        // tests/bind/vectors.json의 message case: IR executor message parameter의 runtime value model JSON이다
        // (docs/protocol.md §5 "Parameters"). Go의 TestBindMessageVectors와 같은 case다.
        $vectors = json_decode((string) file_get_contents(__DIR__ . '/../../../tests/bind/vectors.json'), true, flags: JSON_THROW_ON_ERROR);
        $server = markdown_fake_server(['{"ok":true}']);
        $db = Orm::connect($server[2], new Config());
        self::assertFalse((new DateTimeImmutable("2000-01-01", $db->zone()))->format("P") !== $vectors["zone"], "zone {$db->zone()->getName()}; want {$vectors['zone']}");
        $param = new \ReflectionMethod(\Polyspec\Orm\Markdown::class, 'param');
        foreach ($vectors['message'] as $c) {
            $got = null;
            $e = markdown_error(static function () use ($param, $db, $c, &$got): void {
                $got = $param->invoke(null, $db, 0, $c['value'], [['type' => $c['type'], 'column' => null]]);
            });
            if (isset($c['code'])) {
                self::assertFalse($e?->code_ !== $c['code'], "{$c['name']}: " . json_encode($got) . ' ' . ($e?->getMessage() ?? '') . "; want {$c['code']}");
            } else {
                self::assertFalse($e !== null || $got !== $c['json'], "{$c['name']}: " . json_encode($got) . ' ' . ($e?->getMessage() ?? '') . "; want {$c['json']}");
            }
        }
        $db->close();
        markdown_received($server);
    }

    public function test_bind_vectors(): void
    {
        // tests/bind/vectors.json의 bind case: parameter 값을 그 slot의 논리 type으로 검사한다(docs/protocol.md §5
        // "Parameters"). Go의 TestBindVectors와 같은 case다.
        $vectors = json_decode((string) file_get_contents(__DIR__ . '/../../../tests/bind/vectors.json'), true, flags: JSON_THROW_ON_ERROR);
        $zone = new \DateTimeZone($vectors['zone']);
        // {"int": text}는 int, {"f64": text}는 무한이나 NaN인 float, {"bytes": base64}는 Bytes다.
        $value = static function (mixed $v): mixed {
            if (!is_array($v)) {
                return $v;
            }
            return match (true) {
                isset($v['int']) => (int) $v['int'],
                isset($v['f64']) => match ($v['f64']) { 'NaN' => NAN, 'Infinity' => INF, '-Infinity' => -INF },
                isset($v['bytes']) => new \Polyspec\Orm\Bytes(base64_decode($v['bytes'], true)),
            };
        };
        self::assertNotSame([], $vectors['bind']);
        foreach ($vectors['bind'] as $c) {
            $slot = ['type' => $c['slot']['type'], 'precision' => $c['slot']['precision'] ?? 0, 'scale' => $c['slot']['scale'] ?? 0, 'length' => $c['slot']['length'] ?? 0];
            $v = $value($c['value']);
            $e = markdown_error(static function () use ($v, $slot, $zone): void {
                \Polyspec\Orm\ParamCheck::check(0, $v, $slot, $zone);
            });
            if (isset($c['code'])) {
                self::assertFalse($e?->code_ !== $c['code'], "{$c['name']}: " . ($e?->getMessage() ?? 'bound') . "; want {$c['code']}");
            } else {
                self::assertFalse($e !== null || $v != $value($c['bound']), "{$c['name']}: " . ($e?->getMessage() ?? '') . '; want it bound');
            }
        }
    }

    public function test_param_uses(): void
    {
        $model = RuntimeModel::build(RuntimeModel::parse(['params.dbs' => 'dbspec 1 params

        table owners {
          id varchar(16)
          name varchar(32)
          primary key (id)
        }

        table notes {
          id i64 identity
          owner varchar(16)
          title varchar(64)
          born date null
          at datetime(3)
          version datetime(6) null
          primary key (id)
          index ix_notes_owner (owner)
          foreign key fk_notes_owner (owner) references owners (id)
        }
        ']));
        $validator = new Validator($model);
        /** paramUses의 각 use를 [type, column 이름]으로 줄인 값이다. */
        $usesOf = static fn(array $uses): array => array_map(
            static fn(array $list): array => array_map(static fn(array $u): array => [$u['type'], $u['column']['name'] ?? ''], $list),
            $uses,
        );
        $base = ['ir_version' => 1, 'manifest_hash' => $model->manifestHash];
        $requests = [
            'read' => [$base + ['kind' => 'all', 'entity' => 'notes',
                'where' => ['items' => [
                    ['pred' => ['column' => 'title', 'op' => 'eq', 'p' => 0]],
                    ['pred' => ['conn' => 'and', 'column' => 'born', 'op' => 'between', 'ps' => [1, 2]]],
                    ['pred' => ['conn' => 'and', 'column' => 'at', 'op' => 'eq', 'fn' => ['name' => 'year'], 'p' => 3]],
                    ['pred' => ['conn' => 'and', 'column' => 'at', 'op' => 'gt', 'value' => ['name' => 'days_ago', 'ps' => [4]]]],
                    ['pred' => ['conn' => 'and', 'column' => 'title', 'op' => 'contains', 'p' => 5]],
                    ['pred' => ['conn' => 'and', 'column' => 'at', 'op' => 'eq', 'fn' => ['name' => 'date'], 'p' => 6]],
                    ['pred' => ['conn' => 'and', 'column' => 'at', 'op' => 'lt', 'value' => ['name' => 'seconds_later', 'ps' => [7]]]],
                ]],
                'relations' => [['rel' => 'owner_model', 'kind' => 'one', 'keys' => [['left' => 'owner', 'right' => 'id']],
                    'query' => ['entity' => 'owners', 'if_parent' => ['column' => 'title', 'p' => 8]]]],
                'n_params' => 9], [
                [['varchar', 'title']],
                [['date', 'born']],
                [['date', 'born']],
                [['i64', '']],
                [['i32', '']],
                [['text', '']],
                [['date', '']],
                [['f64', '']],
                [['varchar', 'title']],
            ]],
            'insert' => [$base + ['kind' => 'insert', 'entity' => 'notes',
                'set' => [['column' => 'owner', 'p' => 0], ['column' => 'title', 'p' => 1], ['column' => 'at', 'p' => 2]],
                'rows' => [[3, 4, 5]], 'n_params' => 6], [
                [['varchar', 'owner']], [['varchar', 'title']], [['datetime', 'at']],
                [['varchar', 'owner']], [['varchar', 'title']], [['datetime', 'at']],
            ]],
            'update' => [$base + ['kind' => 'update', 'entity' => 'notes',
                'where' => ['items' => [['pred' => ['column' => 'id', 'op' => 'eq', 'p' => 0]]]],
                'set' => [['column' => 'title', 'p' => 1]],
                'optimistic' => ['column' => 'version', 'p' => 2], 'n_params' => 3], [
                [['i64', 'id']], [['varchar', 'title']], [['datetime', 'version']],
            ]],
        ];
        foreach ($requests as $name => [$request, $want]) {
            $validator->validate($request);
            self::assertFalse(($got = $usesOf($validator->paramUses($request))) !== $want, "$name uses = " . json_encode($got) . "\nwant " . json_encode($want));
        }
    }

}
