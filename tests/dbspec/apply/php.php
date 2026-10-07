<?php

declare(strict_types=1);

// plans.json(tests/dbspec/plans.json)의 chain(create-from-empty 와
// rename-table-and-column)을 PHP client 로 한 database 에 적용한다
// (docs/plans.md "Apply"). action 은 apply-first(첫 plan 만), apply(chain 전체),
// stop(둘째 plan 의 statement 1 이 실행된 뒤 멈춤), recover(중단된 plan 을 이어
// 끝냄), rollback(history 의 마지막 plan 을 되돌림) 중 하나다. stdout 에는 결과 한 줄을 쓴다: "ok", "stopped" 또는
// "error <code>". 그 밖의 error 는 stderr 에 쓰고 1 로 끝난다.
//
// Usage: php tests/dbspec/apply/php.php <apply-first|apply|stop|recover|rollback> <mysql|postgres|sqlite> <uri> <plans.json>

require __DIR__ . '/../../../vendor-php/autoload.php';
require __DIR__ . '/../input.php';

use Polyspec\Orm\Dbspec\ApplyError;
use Polyspec\Orm\Dbspec\ApplyEvent;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Orm;

// 모든 client 가 새 connection 에서 실행하는 statement 다(tests/dialects connectionRules).
const CONNECTION_RULES = ['mysql' => ["SET time_zone = '+00:00'"], 'postgres' => ["SET TimeZone = 'UTC'"], 'sqlite' => ['PRAGMA foreign_keys = ON']];

if ($argc !== 5) {
    fwrite(STDERR, "usage: php tests/dbspec/apply/php.php <apply-first|apply|stop|recover|rollback> <mysql|postgres|sqlite> <uri> <plans.json>\n");
    exit(2);
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
