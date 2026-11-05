<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Closure;
use DateTimeImmutable;
use PDO;
use PHPUnit\Framework\Assert;
use Polyspec\Orm\Dbspec\ApplyCleanupError;
use Polyspec\Orm\Dbspec\ApplyError;
use Polyspec\Orm\Dbspec\ApplyEvent;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Orm;
use Throwable;

/**
 * The ops of the dbspec apply API (docs/spec/feature-coverage.md FCV-4): each command is one call of the public API on
 * a named connection, and steps nested in its on field run inside the event handler.
 */
final class RecipeApply
{
    public const OPS = [
        'dbspec.plan',
        'dbspec.connect',
        'dbspec.exec',
        'dbspec.schema',
        'dbspec.other_database',
        'dbspec.apply',
        'dbspec.recover',
        'dbspec.rollback',
        'dbspec.finalize',
    ];

    /** The statements that a client runs on a new direct connection. */
    private const CONNECTION_RULES = [
        'mysql' => ["SET time_zone = '+00:00'"],
        'postgres' => ["SET TimeZone = 'UTC'"],
        'sqlite' => ['PRAGMA foreign_keys = ON'],
    ];

    private const SERVER_ENV = ['mysql' => 'ORM_TEST_MYSQL_SERVER_DSN', 'postgres' => 'ORM_TEST_POSTGRES_SERVER_DSN'];

    /**
     * @param array<string, mixed> $context
     * @param Closure(array<string, mixed>): void $runStep
     * @return array<string, mixed>
     */
    public static function op(RecipeStep $s, array &$context, Closure $runStep): array
    {
        switch ($s['op']) {
            case 'dbspec.plan':
                $parsed = Dbspec::parsePlan(implode("\n", $s['lines']) . "\n");
                if ($parsed->plan === null) {
                    Assert::fail("dbspec.plan {$s['as']}: " . json_encode($parsed->diagnostics));
                }
                return ['bind' => $parsed->plan];
            case 'dbspec.connect':
                if (($s['through'] ?? null) === 'pooler') {
                    return [
                        'bind' => self::open(self::required('ORM_TEST_PGBOUNCER_DSN'), self::nameOf($context['dsn'])),
                    ];
                }
                return ['bind' => self::direct($context['database'], $context['dsn'])];
            case 'dbspec.exec':
                return self::exec($s, $context);
            case 'dbspec.schema':
                return self::schema($s, $context);
            case 'dbspec.other_database':
                with_case_database(
                    $context['database'],
                    static function (string $step): void {
                    },
                    static function (string $dsn) use ($s, &$context, $runStep): void {
                        $context['bound'][$s['as']] = self::direct($context['database'], $dsn);
                        try {
                            foreach ($s['steps'] as $nested) {
                                $runStep($nested);
                            }
                        } finally {
                            unset($context['bound'][$s['as']]);
                        }
                    }
                );
                return [];
        }
        return self::command($s, $context, $runStep);
    }

    private static function required(string $name): string
    {
        $value = (string) getenv($name);
        if ($value === '') {
            Assert::fail("$name is required; run make orm-test-servers, which starts the databases and writes it");
        }
        return $value;
    }

    private static function nameOf(string $dsn): string
    {
        return ltrim((string) parse_url($dsn, PHP_URL_PATH), '/');
    }

    /** A PDO on the database name of the server of dsn. */
    private static function open(string $dsn, string $name): PDO
    {
        $url = parse_url($dsn);
        $retargeted = "{$url['scheme']}://"
            . (isset($url['user']) ? $url['user'] . (isset($url['pass']) ? ":{$url['pass']}" : '') . '@' : '')
            . ($url['host'] ?? '') . (isset($url['port']) ? ":{$url['port']}" : '') . "/$name"
            . (isset($url['query']) ? "?{$url['query']}" : '');
        [, $pdoDsn, $user, $password] = Orm::parseDsn($retargeted);
        return new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    }

    /** The direct connection to the database of the case DSN dsn, with the rules of a new connection. */
    private static function direct(string $database, string $dsn): PDO
    {
        if ($database === 'sqlite') {
            // A session with busy timeout 0, so it does not wait for the write lock of another session.
            $pdo = new PDO('sqlite:' . substr($dsn, strlen('sqlite://')), null, null, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_TIMEOUT => 0,
            ]);
        } else {
            $pdo = self::open(self::required(self::SERVER_ENV[$database]), self::nameOf($dsn));
        }
        foreach (self::CONNECTION_RULES[$database] as $rule) {
            $pdo->exec($rule);
        }
        return $pdo;
    }

    /** @param array<string, mixed> $context */
    private static function session(RecipeStep $s, array $context): PDO
    {
        $session = $context['bound'][$s['connection']] ?? null;
        if (!$session instanceof PDO) {
            Assert::fail("connection {$s['connection']} is not bound");
        }
        return $session;
    }

    /** @param array<string, mixed> $context @return array<string, mixed> */
    private static function exec(RecipeStep $s, array $context): array
    {
        $text = is_string($s['sql']) ? $s['sql'] : $s['sql'][$context['database']];
        $text = str_replace('{step}', (string) ($context['applyStep'] ?? 0), $text);
        $statement = self::session($s, $context)->query($text);
        $rows = $statement->columnCount() > 0 ? $statement->fetchAll(PDO::FETCH_NUM) : [];
        $statement->closeCursor();
        $array = [];
        foreach ($rows as $row) {
            $array[] = ['array' => array_map(
                static fn(mixed $cell): array => $cell === null ? ['null' => true] : ['text' => (string) $cell],
                $row
            )];
        }
        return ['value' => ['array' => $array]];
    }

    /** @param array<string, mixed> $context @return array<string, mixed> */
    private static function schema(RecipeStep $s, array $context): array
    {
        $result = Dbspec::introspect(self::session($s, $context), $context['database'], 'x');
        if ($result->unsupported !== []) {
            Assert::fail('dbspec.schema: unsupported ' . json_encode($result->unsupported));
        }
        $text = '';
        if ($result->document->tables !== []) {
            $manifest = Dbspec::manifest([$result->document]);
            if ($manifest->manifest === null) {
                Assert::fail('dbspec.schema: ' . json_encode($manifest->diagnostics));
            }
            $text = $manifest->manifest->schemaText;
        }
        return ['value' => ['text' => $text]];
    }

    /**
     * Makes one call of the command; its value is the code of its failure, or ok, and the events that count names.
     *
     * @param array<string, mixed> $context
     * @param Closure(array<string, mixed>): void $runStep
     * @return array<string, mixed>
     */
    private static function command(RecipeStep $s, array &$context, Closure $runStep): array
    {
        $session = self::session($s, $context);
        $plans = [];
        foreach ($s['plans'] as $name) {
            $plans[] = $context['bound'][$name] ?? Assert::fail("plan $name is not bound");
        }
        $events = 0;
        $kinds = [];
        $ran = false;
        $on = $s['on'] ?? null;
        $handler = static function (ApplyEvent $event) use (&$events, &$kinds, &$ran, &$context, $on, $runStep): void {
            $events++;
            $kinds[$event->kind] = ($kinds[$event->kind] ?? 0) + 1;
            if ($on === null || $on['event'] !== $event->kind || ($ran && ($on['every'] ?? false) !== true)) {
                return;
            }
            if (($on['plan'] ?? $event->plan) !== $event->plan || ($on['step'] ?? $event->step) !== $event->step) {
                return;
            }
            $ran = true;
            $context['applyStep'] = $event->step;
            foreach ($on['steps'] ?? [] as $nested) {
                $runStep($nested);
            }
            if (($on['stop'] ?? false) === true) {
                // What an on with stop throws from the event handler, so the code of the command is stopped.
                throw new Stop('the recipe stops the command');
            }
        };
        $now = static fn(): DateTimeImmutable => new DateTimeImmutable('2023-11-14T22:13:20.000000Z');
        $command = substr($s['op'], strlen('dbspec.'));
        $started = hrtime(true);
        $code = 'ok';
        try {
            Dbspec::$command($session, $context['database'], $plans, $now, $handler);
        } catch (Throwable $error) {
            $failure = $error instanceof ApplyCleanupError ? ($error->getPrevious() ?? $error) : $error;
            if ($failure instanceof Stop) {
                $code = 'stopped';
            } elseif ($failure instanceof ApplyError) {
                $code = $failure->code_;
            } elseif (($s['message'] ?? null) === $failure->getMessage()) {
                $code = 'message';
            } else {
                throw $error;
            }
            if (isset($s['detail']) && stripos($failure->getMessage(), $s['detail']) === false) {
                Assert::fail("the message {$failure->getMessage()} does not hold {$s['detail']}");
            }
        }
        $elapsed = (hrtime(true) - $started) / 1_000_000;
        if (
            isset($s['elapsed'])
            && ($elapsed < $s['elapsed']['at_least_ms'] || $elapsed >= $s['elapsed']['below_ms'])
        ) {
            Assert::fail(
                "the command took $elapsed ms, want at least {$s['elapsed']['at_least_ms']} and below "
                    . "{$s['elapsed']['below_ms']}"
            );
        }
        $members = [['code', ['text' => $code]]];
        if (!$s->has('count')) {
            $members[] = ['events', ['int' => (string) $events]];
        }
        foreach ($s['count'] ?? [] as $kind) {
            $members[] = [$kind, ['int' => (string) ($kinds[$kind] ?? 0)]];
        }
        return ['value' => ['object' => $members]];
    }
}
