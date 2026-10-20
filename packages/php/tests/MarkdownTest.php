<?php

declare(strict_types=1);

/*
 * markdown IR executor unit case (docs/spec/protocol.md §5): the markdown DSN, the connect the client sends,
 * the reading of control messages and error lines, the connect the server refuses, the SQL-only surface that a markdown connection refuses,
 * and Validator::paramUses, which reads the slot form for each parameter in the message encoder.
 * The size of a class is Large, that of the largest case (a child process).
 * Instead of the flowmark server, markdown_fake_server.php records the messages of one connection and writes the chosen answers.
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

/** The error code. null if nothing is thrown. */
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
 * Starts markdown_fake_server.php with $answers. The values returned are [process, stdout, dsn, stderr].
 * stderr is received through a pipe: passing this process's STDERR loses the front of the output redirected to a file.
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
 * The message line the fake server received. Waits for the server to finish.
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
    // Requirements: PRT-63.
    public function test_parse_dsn(): void
    {
        $got = Orm::parseMarkdownDsn('markdown://127.0.0.1:4100/tracker?token=' . MARKDOWN_TOKEN);
        self::assertFalse($got !== ['127.0.0.1:4100', 'tracker', MARKDOWN_TOKEN], 'parseMarkdownDsn() = ' . json_encode($got));
        foreach (
            [
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
            ] as $input
        ) {
            $e = markdown_error(static fn() => Orm::parseMarkdownDsn($input));
            self::assertFalse($e?->code_ !== Code::CONFIG, "parseMarkdownDsn($input) = " . ($e?->getMessage() ?? 'no error') . '; want CONFIG');
            $e = markdown_error(static fn() => Orm::connect($input, new Config()));
            self::assertFalse($e?->code_ !== Code::CONFIG, "connect($input) = " . ($e?->getMessage() ?? 'no error') . '; want CONFIG');
        }
    }

    // Requirements: PRT-64.
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
            $db->transaction(static function (): void {
            });
        }, readOnly: true);
        $e = markdown_error(static fn() => $db->transaction(static function (): void {
        }));
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

    // Requirements: PRT-64.
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
            'isolation' => static fn() => $db->transaction(static function (): void {
            }, isolation: 'serializable'),
            'timeoutMs' => static fn() => $db->transaction(static function (): void {
            }, timeoutMs: 100),
            'audit' => static fn() => $db->transaction(static function (): void {
            }, audit: ['account' => 'a']),
            'lock' => static fn() => $db->utils()->lock('k'),
            'setLocal' => static fn() => $db->utils()->setLocal('k', 'v'),
            'local' => static fn() => $db->utils()->local('k'),
            'subscribe' => static fn() => $db->subscribe(static function (): void {
            }),
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

    // Requirements: PRT-66.
    public function test_request_message(): void
    {
        // The request message writes parameters in the slot form: the time compared with a date column is YYYY-MM-DD. A row that is absent
        // group count is an empty result.
        $server = markdown_fake_server(['{"ok":true}', '{"rows":[]}']);
        $db = \Polyspec\Orm\Tests\MarkdownModel\connect($server[2], new Config());
        $groups = (new \Polyspec\Orm\Tests\MarkdownModel\Tasks())->connect($db)
            ->due('2026-10-01')->groupByOwner()->getsCount()->toArray();
        self::assertFalse($groups !== [], 'group count of no rows = ' . json_encode($groups));
        $db->close();
        $received = markdown_received($server);
        $message = json_decode($received[1] ?? 'null', true);
        self::assertFalse(!is_array($message) || $message['params'] !== ['2026-10-01'] || $message['request']['kind'] !== 'group_count'
            || $message['ir_version'] !== 1 || $message['manifest_hash'] !== \Polyspec\Orm\Tests\MarkdownModel\MANIFEST_HASH
            || preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/D', (string) $message['now']) !== 1, 'request message = ' . ($received[1] ?? 'none'));
    }

    // Requirements: PRT-67.
    public function test_bind_message_vectors(): void
    {
        // Message case of tests/bind/vectors.json: the runtime value model JSON of an IR executor message parameter
        // (docs/spec/protocol.md §5 "Parameters"). It is the same case as Go's TestBindMessageVectors.
        $vectors = json_decode((string) file_get_contents(__DIR__ . '/../../../tests/bind/vectors.json'), true, flags: JSON_THROW_ON_ERROR);
        $server = markdown_fake_server(['{"ok":true}']);
        $db = Orm::connect($server[2], new Config());
        self::assertFalse((new DateTimeImmutable("2000-01-01", $db->zone()))->format("P") !== $vectors["zone"], "zone {$db->zone()->getName()}; want {$vectors['zone']}");
        // The control cases: the begin control message of a transaction with and without readOnly (§5 Session).
        self::assertNotEmpty($vectors['control'] ?? [], 'tests/bind/vectors.json has no control cases');
        foreach ($vectors['control'] as $c) {
            self::assertSame($c['json'], \Polyspec\Orm\Markdown::beginMessage($c['read_only']), "control/{$c['name']}");
        }
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
        // Bind case of tests/bind/vectors.json: checks the parameter value against the logical type of its slot (docs/spec/protocol.md §5
        // "Parameters"). It is the same case as Go's TestBindVectors.
        $vectors = json_decode((string) file_get_contents(__DIR__ . '/../../../tests/bind/vectors.json'), true, flags: JSON_THROW_ON_ERROR);
        $zone = new \DateTimeZone($vectors['zone']);
        // {"int": text} is an int, {"f64": text} is a float that is infinite or NaN, and {"bytes": base64} is Bytes.
        $value = static function (mixed $v): mixed {
            if (!is_array($v)) {
                return $v;
            }
            return match (true) {
                isset($v['native']) => match ($v['native']) {
                    'date' => new \DateTimeImmutable('2024-01-02', new \DateTimeZone('UTC')),
                    'time' => new \DateTimeImmutable('0001-01-01 10:00:00', new \DateTimeZone('UTC')),
                    'datetime' => new \DateTimeImmutable('2024-01-02 03:04:05', new \DateTimeZone('UTC')),
                },
                isset($v['int']) => (int) $v['int'],
                isset($v['f64']) => match ($v['f64']) {
                    'NaN' => NAN, 'Infinity' => INF, '-Infinity' => -INF
                },
                isset($v['bytes']) => new \Polyspec\Orm\Bytes(base64_decode($v['bytes'], true)),
            };
        };
        self::assertNotSame([], $vectors['bind']);
        foreach ($vectors['bind'] as $c) {
            $slot = ['type' => $c['slot']['type'], 'precision' => $c['slot']['precision'] ?? 0, 'scale' => $c['slot']['scale'] ?? 0, 'length' => $c['slot']['length'] ?? 0];
            $v = $value($c['value']);
            $transform = $c['slot']['transform'] ?? '';
            $notNull = $c['slot']['not_null'] ?? false;
            $e = markdown_error(static function () use (&$v, $slot, $zone, $transform, $notNull): void {
                if ($transform !== '') {
                    $v = \Polyspec\Orm\Transform::param($transform, $v);
                } else {
                    \Polyspec\Orm\ParamCheck::checkAssign(0, $v, ['not_null' => $notNull, 'column' => 'column']);
                    \Polyspec\Orm\ParamCheck::check(0, $v, $slot, $zone);
                }
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
        /** Each use of paramUses reduced to [type, column name]. */
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

    public function test_bind_offsetless_datetime_uses_the_connection_zone_under_dst(): void
    {
        // An offset-less datetime is a wall clock in the connection zone (docs/spec/protocol.md §5). The process
        // date.timezone has daylight saving, and 2026-03-08 02:30 does not exist in America/New_York: the
        // connection zone is UTC, so the value must bind unchanged whatever the process zone is.
        $default = date_default_timezone_get();
        date_default_timezone_set('America/New_York');
        try {
            $utc = new \DateTimeZone('UTC');
            self::assertSame('2026-03-08 02:30:00.000000', Db::timeValue('2026-03-08 02:30:00', 'datetime', 6, $utc));
            self::assertSame('2026-03-08 02:30:00.500000', Db::timeValue('2026-03-08T02:30:00.5', 'datetime', 6, $utc));
            self::assertSame('2026-03-08', Db::timeValue('2026-03-08', 'date', 0, $utc));
        } finally {
            date_default_timezone_set($default);
        }
    }
}
