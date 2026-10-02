<?php
declare(strict_types=1);
// audit_triggers feature coverage: contracts/fixtures/audit.dbs을 bench
// database에 설치하고 clients/go/orm/audit_operation_test.go의 순서로 쓴 뒤,
// trigger가 남긴 item_history를 확인하고 설치한 table과 PostgreSQL function을
// 지운다. audit document의 model은 임시 directory에 생성하므로 bench model을
// 읽지 않는다: 한 process는 한 document set의 model만 가진다.

require dirname(__DIR__) . '/vendor/autoload.php';
require __DIR__ . '/coverage_cases.php';

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

/** audit document의 model을 $work에 생성하고 설치, 쓰기, history 확인, 정리를 실행한다. */
function auditCase(string $dsn, string $document, string $work): void
{
    Generator::generate(RuntimeModel::build(RuntimeModel::parse(['audit.dbs' => $document])), "$work/gen", 'CoverageAudit\\Orm');
    spl_autoload_register(static function (string $class) use ($work): void {
        if (str_starts_with($class, 'CoverageAudit\\Orm\\')) {
            require "$work/gen/" . substr($class, strlen('CoverageAudit\\Orm\\')) . '.php';
        }
    });
    require "$work/gen/bootstrap.php";
    $db = Orm::connect($dsn, new Config());
    try {
        coverageWant(!auditTable($db, 'item') && !auditTable($db, 'item_history'), 'item or item_history exists before the case');
        coverageRestoring(function () use ($db, $document): void {
            $db->utils()->schema()->install([$document]);
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
        }, fn() => dropAudit($db));
        coverageWant(!auditTable($db, 'item') && !auditTable($db, 'item_history'), 'the audit tables remain');
    } finally {
        $db->close();
    }
}

runCoverageCases($argv, [
    'audit_history' => function (): void {
        [, $dsn] = coverageDatabase();
        $root = dirname(__DIR__, 3);
        $document = file_get_contents("$root/contracts/fixtures/audit.dbs");
        if ($document === false) {
            throw new RuntimeException('cannot read contracts/fixtures/audit.dbs');
        }
        $work = sys_get_temp_dir() . '/orm-php-coverage-audit-' . getmypid();
        if (!mkdir($work, 0o700, true)) {
            throw new RuntimeException("cannot create $work");
        }
        try {
            auditCase($dsn, $document, $work);
        } finally {
            exec('rm -rf ' . escapeshellarg($work), $output, $status);
            if ($status !== 0) {
                throw new RuntimeException("cannot remove $work");
            }
        }
    },
]);
