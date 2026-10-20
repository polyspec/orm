<?php

declare(strict_types=1);

// Applies the chain of plans.json (tests/dbspec/plans.json), create-from-empty and
// rename-table-and-column, to one database with the PHP extension polyspec_orm (Polyspec\Orm\Dbspec\Native)
// (docs/spec/plans.md "Apply"). action is one of apply-first (first plan only), apply (whole chain),
// stop (stops after statement 1 of the second plan runs), recover (finishes the interrupted plan),
// rollback (reverts the last plan in history). stdout gets one result line: "ok", "stopped", or
// "error <code>". Any other error is written to stderr and exits with 1.
//
// The DSN is converted to PDO arguments with the PHP client's Orm::parseDsn.
//
// Usage: php -d extension=<polyspec_orm library> packages/php-ext/testing/dbspec/apply/php-extension.php <apply-first|apply|stop|recover|rollback> <mysql|postgres|sqlite> <uri> <plans.json>

require __DIR__ . '/../../../../../vendor-php/autoload.php';
require __DIR__ . '/../../../../../tests/dbspec/input.php';

use Polyspec\Orm\Dbspec\Native\ApplyError;
use Polyspec\Orm\Dbspec\Native\ApplyEvent;
use Polyspec\Orm\Dbspec\Native\Dbspec;
use Polyspec\Orm\Orm;

// Statement that every client runs on a new connection (packages/go/internal/dialects connectionRules).
const CONNECTION_RULES = ['mysql' => ["SET time_zone = '+00:00'"], 'postgres' => ["SET TimeZone = 'UTC'"], 'sqlite' => ['PRAGMA foreign_keys = ON']];

if ($argc !== 5) {
    fwrite(STDERR, "usage: php -d extension=<polyspec_orm library> packages/php-ext/testing/dbspec/apply/php-extension.php <apply-first|apply|stop|recover|rollback> <mysql|postgres|sqlite> <uri> <plans.json>\n");
    exit(2);
}
if (!extension_loaded('polyspec_orm')) {
    fwrite(STDERR, "the extension polyspec_orm is not loaded; run this with php -d extension=<polyspec_orm library>, which make dbspec-apply-pairs-check builds\n");
    exit(1);
}
[, $action, $dialect, $uri, $vectorsPath] = $argv;
try {
    $vectors = json_decode(dbspec_read_input($vectorsPath), true, 512, JSON_THROW_ON_ERROR);
} catch (JsonException $e) {
    fwrite(STDERR, "$vectorsPath: {$e->getMessage()}\n");
    exit(1);
}
$plans = [];
foreach ($vectors['cases'] as $case) {
    if ($case['id'] === 'create-from-empty' || $case['id'] === 'rename-table-and-column') {
        $parsed = Dbspec::parsePlan(implode("\n", $case['plan']) . "\n");
        $plans[] = $parsed->plan ?? throw new RuntimeException("{$case['id']}: " . json_encode($parsed->diagnostics));
    }
}
if (count($plans) !== 2 || $plans[1]->from !== $plans[0]->to) {
    throw new RuntimeException('plans.json does not chain create-from-empty and rename-table-and-column');
}
[, $pdoDsn, $user, $password] = Orm::parseDsn($uri);
$pdo = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
foreach (CONNECTION_RULES[$dialect] ?? throw new InvalidArgumentException("unknown dialect $dialect") as $rule) {
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
        'stop' => Dbspec::apply($pdo, $dialect, $plans, $now, static function (ApplyEvent $event) use ($plans, $stop): void {
            if ($event->kind === 'applied' && $event->plan === $plans[1]->name && $event->step === 1) {
                throw $stop;
            }
        }),
        default => throw new InvalidArgumentException("unknown action $action"),
    };
} catch (ApplyError $e) {
    echo "error {$e->code_}\n";
    exit(0);
} catch (RuntimeException $e) {
    if ($e !== $stop) {
        throw $e;
    }
    echo "stopped\n";
    exit(0);
}
if ($action === 'stop') {
    throw new RuntimeException('stop: apply did not stop');
}
echo "ok\n";
