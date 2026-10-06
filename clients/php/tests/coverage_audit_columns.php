<?php
declare(strict_types=1);
// audit_triggers feature coverage: contracts/fixtures/audit_columns.dbs를 bench
// database에 설치하고, client가 쓴 insert, update, soft delete를 audit trigger가
// 고른 column만으로 기록하는지 확인한다. card는 exclude (secret)로 secret을 빼고,
// tag는 include (label)로 label과 audit column만 기록하며, history table에는
// 기록하는 column만 있다. 두 table은 audit source를 가진 연결의 audit transaction으로
// 쓴다. 끝에 설치한 table과 PostgreSQL function을 지운다.
// document의 model은 임시 directory에 생성한다: 한 process는 한 document set의
// model만 가진다.

require dirname(__DIR__) . '/vendor/autoload.php';
require __DIR__ . '/coverage_cases.php';

use Polyspec\Orm\Tests\CoverageAuditColumns\Card;
use Polyspec\Orm\Tests\CoverageAuditColumns\Tag;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\RuntimeModel;

/** connection의 database에 table이 있는지 catalog에서 읽는다. */
function auditColumnsTable(Db $db, string $table): bool
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
function dropAuditColumns(Db $db): void
{
    $quote = $db->driver() === 'mysql' ? static fn(string $n): string => "`$n`" : static fn(string $n): string => "\"$n\"";
    foreach (['card_history', 'card', 'tag_history', 'tag', 'audit'] as $table) {
        $db->pdo()->exec('DROP TABLE IF EXISTS ' . $quote($table));
    }
    if ($db->driver() === 'postgres') {
        foreach (['card', 'tag'] as $table) {
            foreach (['insert', 'update', 'delete'] as $event) {
                $db->pdo()->exec("DROP FUNCTION IF EXISTS \"$table\$audit_$event\"()");
            }
        }
    }
}

/**
 * query의 column 이름과 row를 문자열로 읽는다. NULL은 'NULL'이다.
 *
 * @return array{list<string>, list<list<string>>}
 */
function auditColumnsRows(Db $db, string $sql): array
{
    $st = $db->pdo()->query($sql);
    $columns = [];
    for ($i = 0; $i < $st->columnCount(); $i++) {
        $columns[] = $st->getColumnMeta($i)['name'];
    }
    $rows = array_map(static fn(array $r): array => array_map(static fn(mixed $v): string => $v === null ? 'NULL' : (string) $v, $r), $st->fetchAll(PDO::FETCH_NUM));
    return [$columns, $rows];
}

/** document의 model을 $work에 생성하고 설치, 쓰기, history 확인, 정리를 실행한다. */
function auditColumnsCase(string $dsn, string $document, string $work): void
{
    Generator::generate(RuntimeModel::build(RuntimeModel::parse(['audit_columns.dbs' => $document])), "$work/gen", 'Polyspec\\Orm\\Tests\\CoverageAuditColumns');
    spl_autoload_register(static function (string $class) use ($work): void {
        if (str_starts_with($class, 'Polyspec\\Orm\\Tests\\CoverageAuditColumns\\')) {
            require "$work/gen/" . substr($class, strlen('Polyspec\\Orm\\Tests\\CoverageAuditColumns\\')) . '.php';
        }
    });
    require "$work/gen/bootstrap.php";
    $db = Orm::connect($dsn, new Config(auditSource: static fn(): array => ['actor' => 'default']));
    try {
        coverageRestoring(function () use ($db): void {
            $db->utils()->schema()->install(\Polyspec\Orm\Tests\CoverageAuditColumns\schema());
            $adb = $db;
            [$seq, $id] = $adb->transaction(function (): array {
                $seq = (new Card)->setTitle('first')->setSecret('s1')->create()->getSeq();
                $id = (new Tag)->setLabel('x')->setColor('red')->create()->getId();
                (new Card)->getBySeq($seq)->setTitle('second')->setSecret('s2')->update();
                return [$seq, $id];
            }, audit: ['actor' => 'first'], retry: 0);
            $adb->transaction(function () use ($seq, $id): void {
                (new Card)->getBySeq($seq)->delete();
                (new Tag)->getById($id)->setColor('blue')->update();
            }, audit: ['actor' => 'second'], retry: 0);
            $change = $db->driver() === 'mysql' ? '`change`' : '"change"';
            [$columns] = auditColumnsRows($db, 'SELECT * FROM card_history ORDER BY history_id');
            $want = ['history_id', 'change', 'previous_audit_seq', 'seq', 'title', 'audit_seq', 'deleted_at'];
            coverageWant($columns === $want, 'card_history columns ' . json_encode($columns) . ', want ' . json_encode($want));
            [, $rows] = auditColumnsRows($db, "SELECT $change, previous_audit_seq, seq, title, audit_seq, CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END FROM card_history ORDER BY history_id");
            $want = [
                ['insert', 'NULL', "$seq", 'first', '1', 'live'],
                ['update', '1', "$seq", 'second', '1', 'live'],
                ['update', '1', "$seq", 'second', '2', 'deleted'],
            ];
            coverageWant($rows === $want, 'card_history ' . json_encode($rows) . ', want ' . json_encode($want));
            [$columns] = auditColumnsRows($db, 'SELECT * FROM tag_history ORDER BY history_id');
            $want = ['history_id', 'change', 'previous_audit_seq', 'label', 'audit_seq'];
            coverageWant($columns === $want, 'tag_history columns ' . json_encode($columns) . ', want ' . json_encode($want));
            [, $rows] = auditColumnsRows($db, "SELECT $change, previous_audit_seq, label, audit_seq FROM tag_history ORDER BY history_id");
            $want = [['insert', 'NULL', 'x', '1'], ['update', '1', 'x', '2']];
            coverageWant($rows === $want, 'tag_history ' . json_encode($rows) . ', want ' . json_encode($want));
        }, fn() => dropAuditColumns($db));
        foreach (['audit', 'card', 'card_history', 'tag', 'tag_history'] as $table) {
            coverageWant(!auditColumnsTable($db, $table), "table $table remains after the case");
        }
    } finally {
        $db->close();
    }
}

runCoverageCases($argv, [
    'audit_selected_columns' => function (): void {
        [, $dsn] = coverageDatabase();
        $root = dirname(__DIR__, 3);
        $document = file_get_contents("$root/contracts/fixtures/audit_columns.dbs");
        if ($document === false) {
            throw new RuntimeException('cannot read contracts/fixtures/audit_columns.dbs');
        }
        $work = sys_get_temp_dir() . '/orm-php-coverage-audit-columns-' . getmypid();
        if (!mkdir($work, 0o700, true)) {
            throw new RuntimeException("cannot create $work");
        }
        try {
            auditColumnsCase($dsn, $document, $work);
        } finally {
            exec('rm -rf ' . escapeshellarg($work), $output, $status);
            if ($status !== 0) {
                throw new RuntimeException("cannot remove $work");
            }
        }
    },
]);
