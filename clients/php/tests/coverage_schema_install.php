<?php
declare(strict_types=1);
// schema_install feature coverage: 생성된 model이 담은 bench manifest를 이미
// 설치된 bench database에 다시 설치하면 아무것도 바꾸지 않고, 일부 table만 있는
// document set의 설치는 CONFIG로 실패하며 빠진 table을 만들지 않는다.

require __DIR__ . '/autoload.php';
require __DIR__ . '/coverage_cases.php';

use Orm\Code;
use Orm\Db;
use Polyspec\Orm\Tests\Model\Author;
use Orm\Registry;

const PARTIAL_DOCUMENT = <<<'DBSPEC'
dbspec 1 partial

table user {
  seq i64 identity
  name varchar(191)
  primary key (seq)
}

table coverage_install_missing {
  seq i64 identity
  primary key (seq)
}

DBSPEC;

/** connection의 database에 table이 있는지 catalog에서 읽는다. */
function installedTable(Db $db, string $table): bool
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

runCoverageCases($argv, [
    'schema_install_existing' => function (): void {
        [, $dsn] = coverageDatabase();
        $db = coverageConnect($dsn);
        try {
            coverageWant(installedTable($db, 'author'), 'the bench database has no author table');
            // generated model이 등록한 manifest hash의 manifest text를 설치한다.
            $db->utils()->schema()->install([Registry::manifestText(Author::meta()['manifest_hash'])]);
        } finally {
            $db->close();
        }
    },
    'schema_install_partial' => function (): void {
        [, $dsn] = coverageDatabase();
        $db = coverageConnect($dsn);
        try {
            coverageWant(!installedTable($db, 'coverage_install_missing'), 'coverage_install_missing exists before the case');
            $code = coverageCode(fn() => $db->utils()->schema()->install([PARTIAL_DOCUMENT]));
            coverageWant($code === Code::CONFIG, "a partly installed document set is $code, want CONFIG");
            coverageWant(!installedTable($db, 'coverage_install_missing'), 'the rejected install created coverage_install_missing');
        } finally {
            $db->close();
        }
    },
]);
