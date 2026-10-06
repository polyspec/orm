<?php
declare(strict_types=1);
// audit_triggers feature coverage: contracts/fixtures/audit.dbs를 bench database에 설치하고
// clients/go/orm/audit_transaction_test.go의 auditCase와 같은 순서로 audit transaction으로 쓴 뒤,
// trigger가 남긴 item_history와 audit 기록을 확인하고 설치한 table과 PostgreSQL function을 지운다.
// soft_delete_restore는 contracts/fixtures/restore.dbs로 같은 일을 한다. fixture의 model은
// fixture마다 자기 namespace로 임시 directory에 생성하며 bench model은 읽지 않는다.

require dirname(__DIR__) . '/vendor/autoload.php';
require __DIR__ . '/coverage_cases.php';
require __DIR__ . '/restore_case.php';
require __DIR__ . '/audit_case.php';

use Polyspec\Orm\Tests\CoverageAudit\Item;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\RuntimeModel;

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

/**
 * 설치한 table을 audit 기록 table을 가리키는 table부터 지우고, table과 함께 지워지지 않는
 * PostgreSQL trigger function을 지운다.
 *
 * @param list<string> $tables 지울 순서의 table
 * @param list<string> $audited audit trigger function을 가진 table
 */
function dropFixture(Db $db, array $tables, array $audited): void
{
    $quote = $db->driver() === 'mysql' ? static fn(string $n): string => "`$n`" : static fn(string $n): string => "\"$n\"";
    foreach ($tables as $table) {
        $db->pdo()->exec('DROP TABLE IF EXISTS ' . $quote($table));
    }
    if ($db->driver() === 'postgres') {
        foreach ($audited as $table) {
            foreach (['insert', 'update', 'delete'] as $event) {
                $db->pdo()->exec("DROP FUNCTION IF EXISTS \"$table\$audit_$event\"()");
            }
        }
    }
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
    fixtureModels('audit', 'Polyspec\\Orm\\Tests\\CoverageAudit');
}

/** audit fixture가 만드는 table이다. */
const AUDIT_TABLES = ['audit', 'item', 'item_history'];

/**
 * actor 'default'를 주는 audit source로 고른 database에 연결해 audit document를 설치하고
 * $body($db, $dsn)를 실행한 뒤, 실패해도 설치한 table과 function을 지운다.
 *
 * @param Closure(Db, string): void $body
 */
function withAudit(Closure $body): void
{
    [, $dsn] = coverageDatabase();
    auditModels();
    $db = Orm::connect($dsn, auditConfig('default'));
    try {
        foreach (AUDIT_TABLES as $table) {
            coverageWant(!auditTable($db, $table), "$table exists before the case");
        }
        coverageRestoring(function () use ($db, $dsn, $body): void {
            $db->utils()->schema()->install(\Polyspec\Orm\Tests\CoverageAudit\schema());
            $body($db, $dsn);
        }, fn() => dropFixture($db, ['item_history', 'item', 'audit'], ['item']));
        foreach (AUDIT_TABLES as $table) {
            coverageWant(!auditTable($db, $table), "$table remains after the case");
        }
    } finally {
        $db->close();
    }
}

runCoverageCases($argv, [
    // audit transaction은 audit 기록 하나를 삽입하고 audit table의 write가 그 key를 쓴다(audit_case.php).
    'audit_history' => function (): void {
        withAudit(fn(Db $db, string $dsn) => auditCase($db, $dsn, 'Polyspec\\Orm\\Tests\\CoverageAudit'));
    },
    // 모든 transaction 진입점이 audit 값을 받는다: PHP의 진입점은 audit source를 가진 연결의 Db::transaction
    // 하나이며, 두 transaction이 audit 기록을 하나씩 삽입하고 audit 대상 write가 그 key를 쓰고, 중첩
    // transaction은 audit을 받지 않는다.
    'audit_transaction_entry_points' => function (): void {
        withAudit(function (Db $db): void {
            $adb = $db;
            $seq = $adb->transaction(fn(): int => (new Item)->setTitle('first')->create()->getSeq(), audit: ['actor' => 'transaction'], retry: 0);
            $adb->transaction(fn() => (new Item)($adb)->setSeq($seq)->setTitle('second')->update(), audit: ['actor' => 'connected'], retry: 0);
            $nested = auditErrorCode(fn() => $adb->transaction(fn() => $adb->transaction(fn() => null, audit: ['actor' => 'nested']), audit: [], retry: 0));
            coverageWant($nested === Code::CONFIG, "a nested transaction with an audit is $nested, want CONFIG");
            $s = (string) $seq;
            $history = auditItemHistory($db);
            $want = [
                ['insert', 'NULL', $s, 'first', '1', 'live'],
                ['update', '1', $s, 'second', '2', 'live'],
            ];
            coverageWant($history === $want, 'history ' . json_encode($history) . ', want ' . json_encode($want));
            $records = auditTextRows($db, 'SELECT seq, actor FROM audit ORDER BY seq');
            coverageWant($records === [['1', 'transaction'], ['2', 'connected']], 'audit records ' . json_encode($records));
        });
    },
    // soft delete한 행을 restore로 되돌린다(restore_case.php): unique key와 exclude 목록을 가진 audit table과
    // audit 없는 table이다. 끝나면 설치한 table과 PostgreSQL trigger function을 지운다.
    'soft_delete_restore' => function (): void {
        [, $dsn] = coverageDatabase();
        fixtureModels('restore', 'Polyspec\\Orm\\Tests\\CoverageRestore');
        $tables = ['audit', 'label', 'membership', 'membership_history'];
        $db = Orm::connect($dsn, auditConfig('default'));
        try {
            foreach ($tables as $table) {
                coverageWant(!auditTable($db, $table), "$table exists before the case");
            }
            coverageRestoring(function () use ($db): void {
                $db->utils()->schema()->install(\Polyspec\Orm\Tests\CoverageRestore\schema());
                restoreCase($db, 'Polyspec\\Orm\\Tests\\CoverageRestore');
            }, fn() => dropFixture($db, ['membership_history', 'membership', 'label', 'audit'], ['membership']));
            foreach ($tables as $table) {
                coverageWant(!auditTable($db, $table), "$table remains after the case");
            }
        } finally {
            $db->close();
        }
    },
]);
