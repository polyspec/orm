<?php

declare(strict_types=1);

use Polyspec\Orm\Dbspec\ApplyError;
use Polyspec\Orm\Dbspec\ApplyEvent;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Orm;

/** @return list<Polyspec\Orm\Dbspec\Plan> */
function dbspec_apply_runner_plans(array $vectors): array
{
    $plans = [];
    foreach ($vectors['cases'] as $case) {
        if ($case['id'] === 'create-from-empty' || $case['id'] === 'rename-table-and-column') {
            $parsed = Dbspec::parsePlan(implode("\n", $case['plan']) . "\n");
            $plans[] = $parsed->plan ?? throw new RuntimeException(
                "{$case['id']}: " . json_encode($parsed->diagnostics)
            );
        }
    }
    if (count($plans) !== 2 || $plans[1]->from !== $plans[0]->to) {
        throw new RuntimeException('plans.json does not chain create-from-empty and rename-table-and-column');
    }
    return $plans;
}

/** Runs the shared dbspec apply scenario. The entrypoints retain their mode-specific checks and usage text. */
function dbspec_apply_runner_run(array $argv): int
{
    [, $action, $dialect, $uri, $vectorsPath] = $argv;
    try {
        $vectors = json_decode(dbspec_read_input($vectorsPath), true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        fwrite(STDERR, "$vectorsPath: {$e->getMessage()}\n");
        return 1;
    }
    $plans = dbspec_apply_runner_plans($vectors);
    $connectionRules = [
        'mysql' => ["SET time_zone = '+00:00'"],
        'postgres' => ["SET TimeZone = 'UTC'"],
        'sqlite' => ['PRAGMA foreign_keys = ON']
    ];
    [, $pdoDsn, $user, $password] = Orm::parseDsn($uri);
    $pdo = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    foreach ($connectionRules[$dialect] ?? throw new InvalidArgumentException("unknown dialect $dialect") as $rule) {
        $pdo->exec($rule);
    }
    $now = static fn(): DateTimeImmutable => new DateTimeImmutable('2026-10-01T00:00:00.123456789Z');
    $stop = new RuntimeException('stop');
    try {
        match ($action) {
            'apply-first' => Dbspec::apply($pdo, $dialect, [$plans[0]], $now, null),
            'apply' => Dbspec::apply($pdo, $dialect, $plans, $now, null),
            'recover' => Dbspec::recover($pdo, $dialect, $plans, $now, null),
            'rollback' => Dbspec::rollback($pdo, $dialect, $plans, $now, null),
            'stop' => Dbspec::apply($pdo, $dialect, $plans, $now, static function (
                ApplyEvent $event
            ) use (
                $plans,
                $stop
            ): void {
                if ($event->kind === 'applied' && $event->plan === $plans[1]->name && $event->step === 1) {
                    throw $stop;
                }
            }),
            default => throw new InvalidArgumentException("unknown action $action"),
        };
    } catch (ApplyError $e) {
        echo "error {$e->code_}\n";
        return 0;
    } catch (RuntimeException $e) {
        if ($e !== $stop) {
            throw $e;
        }
        echo "stopped\n";
        return 0;
    }
    if ($action === 'stop') {
        throw new RuntimeException('stop: apply did not stop');
    }
    echo "ok\n";
    return 0;
}
