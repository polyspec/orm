<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

/*
 * markdown IR executor unit case (docs/spec/protocol.md §5): the markdown DSN, the connect the client sends,
 * the reading of control messages and error lines, the connect the server refuses, and the SQL-only surface that a markdown
 * connection refuses.
 * The size of a class is Large, that of the largest case (a child process).
 * Instead of the flowmark server, markdown_test_server.php records the messages of one connection and writes the chosen
 * answers.
 */


use Closure;
use DateTimeImmutable;
use RuntimeException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Markdown;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Request;
use Polyspec\Orm\Schema;
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
 * Starts markdown_test_server.php with $answers. The values returned are [process, stdout, dsn, stderr].
 * stderr is received through a pipe: passing this process's STDERR loses the front of the output redirected to a file.
 *
 * @param list<string> $answers
 * @return array{0: resource, 1: resource, 2: string, 3: resource}
 */
function start_markdown_test_server(array $answers): array
{
    $process = proc_open(
        [PHP_BINARY, __DIR__ . '/markdown_test_server.php', ...$answers],
        [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes
    );
    if ($process === false) {
        throw new RuntimeException('cannot start markdown_test_server.php');
    }
    $port = trim((string) fgets($pipes[1]));
    if (preg_match('/^[0-9]+$/', $port) !== 1) {
        $stderr = (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($process);
        throw new RuntimeException("markdown_test_server.php printed \"$port\", not its port; stderr:\n$stderr");
    }
    return [$process, $pipes[1], "markdown://127.0.0.1:$port/tracker?token=" . MARKDOWN_TOKEN, $pipes[2]];
}

/**
 * The message line the fake server received. Waits for the server to finish.
 *
 * @param array{0: resource, 1: resource, 2: string, 3: resource} $server
 * @return list<string>
 */
function markdown_test_server_received_messages(array $server): array
{
    $line = (string) stream_get_contents($server[1]);
    $stderr = (string) stream_get_contents($server[3]);
    fclose($server[1]);
    fclose($server[3]);
    proc_close($server[0]);
    $received = json_decode($line, true);
    if (!is_array($received)) {
        throw new RuntimeException(
            "markdown_test_server.php printed \"$line\", not the received lines; stderr:\n$stderr"
        );
    }
    return $received;
}

#[Large]
class MarkdownTest extends TestCase
{
    // Requirements: PRT-64.
    public function testSessionMessages(): void
    {
        $server = start_markdown_test_server([
            '{"ok":true}',
            '{"ok":true}', '{"ok":true}', '{"ok":true}', '{"ok":true}',
            '{"ok":true}', '{"error":{"code":"WRITE_CONFLICT","message":"people.flowmark.md:3 changed since it was '
                . 'read"}}',
        ]);
        $db = Orm::connect($server[2], new Config());
        self::assertFalse($db->driver() !== 'markdown', "driver() = {$db->driver()}; want markdown");
        $db->transaction(static function () use ($db): void {
            $db->transaction(static function (): void {
            });
        }, readOnly: true);
        $e = markdown_error(static fn() => $db->transaction(static function (): void {
        }));
        self::assertFalse(
            $e?->code_ !== Code::WRITE_CONFLICT || $e
                ->getMessage() !== 'WRITE_CONFLICT: people.flowmark.md:3 changed since it was read',
            'commit error = ' . ($e?->getMessage() ?? 'none') . "; want WRITE_CONFLICT with the server's message"
        );
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
        self::assertFalse(
            ($got = markdown_test_server_received_messages($server)) !== $want,
            "messages:\n" . implode("\n", $got) . "\nwant:\n" . implode("\n", $want)
        );
    }

    // Requirements: PRT-64.
    public function testConnectRefused(): void
    {
        $server = start_markdown_test_server(
            ['{"error":{"code":"CONFIG","message":"connect: the token is not the corpus\'s token"}}']
        );
        $e = markdown_error(static fn() => Orm::connect($server[2], new Config())->close());
        self::assertFalse(
            $e?->code_ !== Code::CONFIG || $e->getMessage() !== "CONFIG: connect: the token is not the corpus's token",
            'connect error = ' . ($e?->getMessage() ?? 'none') . "; want the server's CONFIG"
        );
        self::assertFalse(
            ($got = markdown_test_server_received_messages($server)) !== [MARKDOWN_CONNECT_LINE],
            'messages = ' . json_encode($got)
        );
    }

    // Requirements: DIA-183, DIA-184, DIA-185, DIA-188, DIA-189.
    public function testRejectedSurfaces(): void
    {
        $server = start_markdown_test_server(['{"ok":true}']);
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
            'privileges' => static fn() => $db->utils()->privileges()->inspectTable('public.items'),
            'AES status' => static fn() => $db->utils()->aes()->status(
                new \Polyspec\Orm\Tests\MarkdownModel\Tasks(),
                new \Polyspec\Orm\AesKeyring([1 => 'key'], 1)
            ),
            'AES rotation' => static fn() => $db->utils()->aes()->rotate(
                new \Polyspec\Orm\Tests\MarkdownModel\Tasks(),
                new \Polyspec\Orm\AesKeyring([1 => 'key'], 1)
            ),
            'schema install' => static fn() => $db->utils()->schema()->install(new Schema('', '')),
            'schema evolution' => static fn() => $db->utils()->schema()->addTablesAndColumns(new Schema('', '')),
            'getQuery' => static fn() => (new \Polyspec\Orm\Tests\MarkdownModel\Tasks())->connect($db)->getQuery(),
        ];
        foreach ($surfaces as $name => $fn) {
            $e = markdown_error($fn);
            self::assertFalse(
                $e?->code_ !== Code::CAPABILITY_UNSUPPORTED,
                "$name: " . ($e?->getMessage() ?? 'no error') . '; want CAPABILITY_UNSUPPORTED'
            );
        }
        $e = markdown_error(static fn() => Orm::connect($server[2], new Config(statementTimeoutMs: 100)));
        self::assertFalse(
            $e?->code_ !== Code::CAPABILITY_UNSUPPORTED,
            'statementTimeoutMs: ' . ($e?->getMessage() ?? 'no error') . '; want CAPABILITY_UNSUPPORTED'
        );
        $db->close();
        markdown_test_server_received_messages($server);
    }

    // Requirements: PRT-66.
    public function testRequestMessage(): void
    {
        // The request message writes parameters in the slot form: the time compared with a date column is YYYY-MM-DD. A
        // row that is absent group count is an empty result.
        $server = start_markdown_test_server(['{"ok":true}', '{"rows":[]}']);
        $db = \Polyspec\Orm\Tests\MarkdownModel\connect($server[2], new Config());
        $groups = (new \Polyspec\Orm\Tests\MarkdownModel\Tasks())->connect($db)
            ->due('2026-10-01')->groupByOwner()->getsCount()->toArray();
        self::assertFalse($groups !== [], 'group count of no rows = ' . json_encode($groups));
        $db->close();
        $received = markdown_test_server_received_messages($server);
        $message = json_decode($received[1] ?? 'null', true);
        self::assertFalse(!is_array($message) || $message['params'] !== [
            '2026-10-01'
        ] || $message['request']['kind'] !== 'group_count'
            || $message['ir_version'] !== 1 || $message[
                'manifest_hash'
            ] !== \Polyspec\Orm\Tests\MarkdownModel\MANIFEST_HASH
            || preg_match(
                '/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/D',
                (string) $message['now']
            ) !== 1, 'request message = ' . ($received[1] ?? 'none'));
    }

    // Requirements: PRT-67, DIA-31.
    public function testBindVectors(): void
    {
        // Bind case of tests/bind/vectors.json: checks the parameter value against the logical type of its slot
        // (docs/spec/protocol.md §5 "Parameters"). It is the same case as Go's TestBindVectors.
        $vectors = json_decode(
            (string) file_get_contents(__DIR__ . '/../../../tests/bind/vectors.json'),
            true,
            flags: JSON_THROW_ON_ERROR
        );
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
            $slot = [
                'type' => $c['slot']['type'],
                'precision' => $c['slot']['precision'] ?? 0,
                'scale' => $c['slot']['scale'] ?? 0,
                'length' => $c['slot']['length'] ?? 0
            ];
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
                self::assertFalse(
                    $e?->code_ !== $c['code'],
                    "{$c['name']}: " . ($e?->getMessage() ?? 'bound') . "; want {$c['code']}"
                );
            } else {
                self::assertFalse(
                    $e !== null || $v != $value($c['bound']),
                    "{$c['name']}: " . ($e?->getMessage() ?? '') . '; want it bound'
                );
            }
        }
    }
}
