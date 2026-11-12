<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

/*
 * The bind cases of tests/bind/vectors.json (docs/spec/protocol.md §5 "Parameters"). The session messages of a markdown
 * connection are cases of the recipe tests/bind/messages.json, whose listeners are markdown_test_server.php: it records
 * the messages of one connection and writes the chosen answers. The size of a class is Large, that of its runners
 * (a child process).
 */


use Closure;
use RuntimeException;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\OrmException;

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
    // Requirements: PRT-66.
    public function testDroppedStatementClosesItsRows(): void
    {
        // A statement whose caller dropped it before its rows ended is not read to the end by the next statement: no
        // one can read those rows, so the session ends them with close.
        $rows = '{"columns":[{"name":"n","type":"INTEGER"}],"rows":[[1]],"affected":0,"last_insert_id":0,"more":%s}';
        $server = start_markdown_test_server(
            ['{"ok":true}', sprintf($rows, 'true'), '{"ok":true}', sprintf($rows, 'false')]
        );
        $db = \Polyspec\Orm\Orm::connect($server[2], new \Polyspec\Orm\Config());
        $statement = $db->pdo()->query('SELECT n FROM a');
        self::assertSame([1], $statement->fetch(\PDO::FETCH_NUM));
        unset($statement);
        $db->pdo()->query('SELECT n FROM b')->fetchAll();
        $db->close();
        $ops = array_map(
            static fn(string $line): string => json_decode($line, true, flags: JSON_THROW_ON_ERROR)['op'],
            markdown_test_server_received_messages($server)
        );
        self::assertSame(['connect', 'statement', 'close', 'statement'], $ops);
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
