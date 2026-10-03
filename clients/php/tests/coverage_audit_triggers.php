<?php
declare(strict_types=1);
// audit_triggers feature coverage: contracts/fixtures/audit.dbs을 bench
// database에 설치하고 clients/go/orm/audit_operation_test.go의 순서로 쓴 뒤,
// trigger가 남긴 item_history를 확인하고 설치한 table과 PostgreSQL function을
// 지운다. soft_delete_restore는 contracts/fixtures/restore.dbs로 같은 일을 한다. fixture의
// model은 fixture마다 자기 namespace로 임시 directory에 생성하며 bench model은 읽지 않는다.

require dirname(__DIR__) . '/vendor/autoload.php';
require __DIR__ . '/coverage_cases.php';
require __DIR__ . '/restore_case.php';

use CoverageAudit\Orm\Item;
use Orm\Code;
use Orm\Config;
use Orm\Db;
use Orm\Generator;
use Orm\Orm;
use Orm\RuntimeModel;

/** connection의 database에 table이 있는지 catalog에서 읽는다. */
function auditTable(Db $db, string $table): bool
{
    $sql = match ($db->driver()) {
        'mysql' => 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        'postgres' => 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?',
        'sqlite' => "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
    };
    $st = $db->pdo()->prepare($sql);
    $st->execute([$table]);
    return (int) $st->fetchColumn() === 1;
}

/** 설치한 table과, table과 함께 지워지지 않는 PostgreSQL trigger function을 지운다. */
function dropAudit(Db $db): void
{
    $quote = $db->driver() === 'mysql' ? static fn(string $n): string => "`$n`" : static fn(string $n): string => "\"$n\"";
    foreach (['item_history', 'item'] as $table) {
        $db->pdo()->exec('DROP TABLE IF EXISTS ' . $quote($table));
    }
    if ($db->driver() === 'postgres') {
        foreach (['insert', 'update', 'delete'] as $event) {
            $db->pdo()->exec("DROP FUNCTION IF EXISTS \"item\$audit_$event\"()");
        }
    }
}

/** native 값을 bool로 읽는다. 다른 값은 오류다. */
function auditBool(mixed $v): bool
{
    return match (true) {
        $v === true, $v === 1, $v === '1', $v === 't' => true,
        $v === false, $v === 0, $v === '0', $v === 'f' => false,
        default => throw new RuntimeException('not a boolean cell: ' . var_export($v, true)),
    };
}

/** native 값을 정수로 읽는다. 다른 값은 오류다. */
function auditInt(mixed $v): int
{
    if (is_int($v)) {
        return $v;
    }
    if (is_string($v) && preg_match('/^-?[0-9]+$/D', $v) === 1) {
        return (int) $v;
    }
    throw new RuntimeException('not an integer cell: ' . var_export($v, true));
}

/** @return list<array{string, ?int, int, string, int, bool}> item_history를 history_id 순서로 읽은 행 */
function auditHistory(Db $db): array
{
    $change = $db->driver() === 'mysql' ? '`change`' : '"change"';
    $rows = $db->pdo()->query("SELECT $change, previous_operation_id, seq, title, operation_id, deleted_at IS NOT NULL FROM item_history ORDER BY history_id")->fetchAll(PDO::FETCH_NUM);
    return array_map(static fn(array $r): array => [
        $r[0], $r[1] === null ? null : auditInt($r[1]), auditInt($r[2]), $r[3], auditInt($r[4]), auditBool($r[5]),
    ], $rows);
}

/**
 * contracts/fixtures/<fixture>.dbs의 model을 임시 directory의 $namespace에 한 번 생성하고 autoload에
 * 등록한다. 한 process의 여러 case가 같은 model을 쓴다. directory는 process가 끝날 때 지운다.
 */
function fixtureModels(string $fixture, string $namespace): void
{
    static $generated = [];
    if (isset($generated[$fixture])) {
        return;
    }
    $root = dirname(__DIR__, 3);
    $document = file_get_contents("$root/contracts/fixtures/$fixture.dbs");
    if ($document === false) {
        throw new RuntimeException("cannot read contracts/fixtures/$fixture.dbs");
    }
    $work = sys_get_temp_dir() . "/orm-php-coverage-$fixture-" . getmypid();
    if (!mkdir($work, 0o700, true)) {
        throw new RuntimeException("cannot create $work");
    }
    $generated[$fixture] = $work;
    register_shutdown_function(static function () use ($work): void {
        exec('rm -rf ' . escapeshellarg($work), $output, $status);
        if ($status !== 0) {
            fwrite(STDERR, "cannot remove $work\n");
            exit(1);
        }
    });
    Generator::generate(RuntimeModel::build(RuntimeModel::parse(["$fixture.dbs" => $document])), "$work/gen", $namespace);
    spl_autoload_register(static function (string $class) use ($work, $namespace): void {
        if (str_starts_with($class, "$namespace\\")) {
            require "$work/gen/" . substr($class, strlen("$namespace\\")) . '.php';
        }
    });
    require "$work/gen/bootstrap.php";
}

/** audit document의 model을 CoverageAudit\Orm에 생성한다. */
function auditModels(): void
{
    fixtureModels('audit', 'CoverageAudit\\Orm');
}

/**
 * 고른 database에 audit document를 설치하고 $body를 실행한 뒤, 실패해도 설치한 table과 function을
 * 지운다.
 *
 * @param Closure(Db): void $body
 */
function withAudit(Closure $body): void
{
    [, $dsn] = coverageDatabase();
    auditModels();
    $db = Orm::connect($dsn, new Config());
    try {
        coverageWant(!auditTable($db, 'item') && !auditTable($db, 'item_history'), 'item or item_history exists before the case');
        coverageRestoring(function () use ($db, $body): void {
            $db->utils()->schema()->install(\CoverageAudit\Orm\schema());
            $body($db);
        }, fn() => dropAudit($db));
        coverageWant(!auditTable($db, 'item') && !auditTable($db, 'item_history'), 'the audit tables remain');
    } finally {
        $db->close();
    }
}

runCoverageCases($argv, [
    'audit_history' => function (): void {
        withAudit(function (Db $db): void {
            $outside = coverageCode(fn() => (new Item)($db)->setTitle('outside')->create());
            coverageWant($outside === Code::CONFIG, "an insert without an operation id is $outside, want CONFIG");
            $seq = $db->transaction(function () use ($db): int {
                $seq = (new Item)->setTitle('first')->create()->getSeq();
                // 중첩 transaction은 바깥 operation id를 쓴다.
                $db->transaction(fn() => (new Item)->getBySeq($seq)->setTitle('second')->update());
                return $seq;
            }, operation: 7, retry: 0);
            $third = coverageCode(fn() => (new Item)($db)->getBySeq($seq)->setTitle('third')->update());
            coverageWant($third === Code::CONFIG, "an update without an operation id is $third, want CONFIG");
            $db->transaction(fn() => (new Item)->getBySeq($seq)->delete(), operation: 8, retry: 0);
            $history = auditHistory($db);
            $want = [
                ['insert', null, $seq, 'first', 7, false],
                ['update', 7, $seq, 'second', 7, false],
                ['update', 7, $seq, 'second', 8, true],
            ];
            coverageWant($history === $want, 'history ' . json_encode($history) . ', want ' . json_encode($want));
        });
    },
    // 모든 transaction 진입점이 operation id를 받는다: PHP의 진입점은 Db::transaction 하나이며, 정한 id를
    // audit 대상 write가 쓰고 중첩 transaction은 operation id를 받지 않는다.
    'audit_operation_entry_points' => function (): void {
        withAudit(function (Db $db): void {
            $seq = $db->transaction(fn(): int => (new Item)->setTitle('first')->create()->getSeq(), operation: 7, retry: 0);
            $db->transaction(fn() => (new Item)->getBySeq($seq)->setTitle('second')->update(), operation: 8, retry: 0);
            $nested = coverageCode(fn() => $db->transaction(fn() => $db->transaction(fn() => null, operation: 10), operation: 9, retry: 0));
            coverageWant($nested === Code::CONFIG, "a nested transaction with an operation id is $nested, want CONFIG");
            $history = auditHistory($db);
            $want = [
                ['insert', null, $seq, 'first', 7, false],
                ['update', 7, $seq, 'second', 8, false],
            ];
            coverageWant($history === $want, 'history ' . json_encode($history) . ', want ' . json_encode($want));
        });
    },
    // soft delete한 행을 restore로 되돌린다(restore_case.php): unique key와 exclude 목록을 가진 audit table과
    // audit 없는 table이다. 끝나면 설치한 table과 PostgreSQL trigger function을 지운다.
    'soft_delete_restore' => function (): void {
        [, $dsn] = coverageDatabase();
        fixtureModels('restore', 'CoverageRestore\\Orm');
        $tables = ['label', 'membership', 'membership_history'];
        $db = Orm::connect($dsn, new Config());
        try {
            foreach ($tables as $table) {
                coverageWant(!auditTable($db, $table), "$table exists before the case");
            }
            coverageRestoring(function () use ($db): void {
                $db->utils()->schema()->install(\CoverageRestore\Orm\schema());
                restoreCase($db, 'CoverageRestore\\Orm');
            }, function () use ($db): void {
                $quote = $db->driver() === 'mysql' ? static fn(string $n): string => "`$n`" : static fn(string $n): string => "\"$n\"";
                foreach (['membership_history', 'membership', 'label'] as $table) {
                    $db->pdo()->exec('DROP TABLE IF EXISTS ' . $quote($table));
                }
                if ($db->driver() === 'postgres') {
                    foreach (['insert', 'update', 'delete'] as $event) {
                        $db->pdo()->exec("DROP FUNCTION IF EXISTS \"membership\$audit_$event\"()");
                    }
                }
            });
            foreach ($tables as $table) {
                coverageWant(!auditTable($db, $table), "$table remains after the case");
            }
        } finally {
            $db->close();
        }
    },
]);
