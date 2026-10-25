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
    if ($action === 'lock-wait') {
        return dbspec_apply_runner_lock_wait($dialect, $uri, $vectors);
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

/** Releases the SQLite blocker before Apply runs its cleanup after a failed exclusive BEGIN. */
final class DbspecApplyLockWaitSqliteConnection extends PDO
{
    public bool $blockerReleased = false;

    public function __construct(string $dsn, ?string $user, ?string $password, array $options, private PDO $blocker)
    {
        parent::__construct($dsn, $user, $password, $options);
    }

    public function exec(string $statement): int|false
    {
        try {
            return parent::exec($statement);
        } catch (PDOException $error) {
            if ($statement === 'BEGIN EXCLUSIVE' && $this->blocker->inTransaction()) {
                $this->blocker->exec('ROLLBACK');
                $this->blockerReleased = true;
            }
            throw $error;
        }
    }
}

/**
 * Runs PLN-90's bounded lock wait against the same representative plan as the Python physical case.
 */
function dbspec_apply_runner_lock_wait(string $dialect, string $uri, array $vectors): int
{
    $representative = null;
    foreach ($vectors['cases'] as $case) {
        if ($case['id'] === 'representative') {
            $representative = $case;
            break;
        }
    }
    if ($representative === null) {
        throw new RuntimeException('plans.json has no representative case');
    }
    $sourceText = implode("\n", ['dbplan 1 base', 'from empty', '', ...$representative['source']]) . "\n";
    $source = Dbspec::parsePlan($sourceText)->plan;
    $target = Dbspec::parsePlan(implode("\n", $representative['plan']) . "\n")->plan;
    if ($source === null || $target === null || $target->from !== $source->to) {
        throw new RuntimeException('plans.json does not form the representative lock-wait plan');
    }

    [, $pdoDsn, $user, $password] = Orm::parseDsn($uri);
    $options = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION];
    $blocker = new PDO($pdoDsn, $user, $password, $options);
    $connection = null;
    $blockerTransaction = false;
    $result = null;
    try {
        $rules = [
            'mysql' => ["SET time_zone = '+00:00'"],
            'postgres' => ["SET TimeZone = 'UTC'"],
            'sqlite' => ['PRAGMA foreign_keys = ON'],
        ];
        foreach ($rules[$dialect] ?? throw new InvalidArgumentException("unknown dialect $dialect") as $rule) {
            $blocker->exec($rule);
        }
        $now = static fn(): DateTimeImmutable => new DateTimeImmutable('2026-10-01T00:00:00.123456789Z');
        if ($dialect === 'sqlite') {
            $blocker->exec('BEGIN EXCLUSIVE');
            $blockerTransaction = true;
            $connection = new DbspecApplyLockWaitSqliteConnection($pdoDsn, $user, $password, $options, $blocker);
            $plans = [];
            $wantCode = 'locked';
        } else {
            $connection = new PDO($pdoDsn, $user, $password, $options);
            foreach ($rules[$dialect] as $rule) $connection->exec($rule);
            Dbspec::apply($connection, $dialect, [$source], $now, null);
            $blocker->beginTransaction();
            $blockerTransaction = true;
            $blocker->exec("INSERT INTO archive (note) VALUES ('lock wait')");
            $statement = $blocker->query('SELECT id FROM archive FOR UPDATE');
            if ($statement === false) {
                throw new RuntimeException('could not lock the representative archive row');
            }
            $statement->fetchAll(PDO::FETCH_NUM);
            $statement->closeCursor();
            $plans = [$source, $target];
            $wantCode = 'failed';
        }

        $events = [];
        $started = hrtime(true);
        try {
            Dbspec::apply($connection, $dialect, $plans, $now, static function (ApplyEvent $event) use (&$events): void {
                if ($event->kind === 'statement' || $event->kind === 'applied') {
                    $events[] = [$event->kind, $event->step];
                }
            });
        } catch (ApplyError $error) {
            $elapsed = (hrtime(true) - $started) / 1_000_000_000;
            if ($error->code_ !== $wantCode) {
                throw new RuntimeException("lock wait returned {$error->code_}; want $wantCode", 0, $error);
            }
            $cause = $error->getPrevious();
            if ($cause === null || !str_contains(strtolower($cause->getMessage()), 'lock')
                && !str_contains(strtolower($cause->getMessage()), 'timeout')) {
                throw new RuntimeException('lock wait failure does not preserve a lock/timeout database cause', 0, $error);
            }
            if ($dialect !== 'sqlite') {
                if ($error->plan !== 'representative' || $error->step !== 0) {
                    throw new RuntimeException(
                        "statement lock wait failed at {$error->plan} step {$error->step}; want representative step 0",
                        0,
                        $error
                    );
                }
                if ($events !== [['statement', 0]]) {
                    throw new RuntimeException('statement event sequence differs from [statement, 0]');
                }
            }
            if ($elapsed < 4 || $elapsed >= 10) {
                throw new RuntimeException(sprintf('lock wait returned after %.3fs; want 4s <= elapsed < 10s', $elapsed));
            }
            $result = "error {$error->code_}";
        }
        if ($result === null) {
            throw new RuntimeException('apply did not stop at the held database lock');
        }
    } finally {
        if ($blockerTransaction && !($connection instanceof DbspecApplyLockWaitSqliteConnection && $connection->blockerReleased)) {
            if ($dialect === 'sqlite') {
                $blocker->exec('ROLLBACK');
            } else {
                $blocker->rollBack();
            }
        }
        $blocker = null;
        $connection = null;
    }
    echo "$result\n";
    return 0;
}
