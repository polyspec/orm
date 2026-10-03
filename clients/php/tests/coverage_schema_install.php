<?php
declare(strict_types=1);
// schema_install feature coverage: 생성된 model이 담은 bench manifest를 이미
// 설치된 bench database에 다시 설치하면 아무것도 바꾸지 않고, 일부 table만 있는
// document set의 설치는 CONFIG로 실패하며 빠진 table을 만들지 않는다. 외부 문서를 쓰는 set의
// 연결과 설치는 외부 table을 database에서 확인한다.

require __DIR__ . '/autoload.php';
require __DIR__ . '/coverage_cases.php';

use Orm\Code;
use Orm\Config;
use Orm\Db;
use Orm\Orm;
use Orm\OrmException;
use Orm\RuntimeModel;
use Orm\Schema;

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

/** bench database의 table user를 외부 문서로 쓰는 document set의 외부 문서다. */
const EXTERNAL_USER = <<<'DBSPEC'
dbspec 1 bench_user

table user {
  seq i64 identity
  name varchar(191)
  primary key (seq)
}

DBSPEC;

/** EXTERNAL_USER의 user를 쓰고 coverage_external_post만 소유하는 문서다. */
const EXTERNAL_MEMBER = <<<'DBSPEC'
dbspec 1 coverage_external

use bench_user { user }

table coverage_external_post {
  seq i64 identity
  user_seq i64
  primary key (seq)
  index ix_coverage_external_post_user (user_seq)
  foreign key fk_coverage_external_post_user (user_seq) references user (seq)
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
            // generated code의 schema 값을 설치한다.
            $db->utils()->schema()->install(\Polyspec\Orm\Tests\Model\schema());
        } finally {
            $db->close();
        }
    },
    'schema_install_partial' => function (): void {
        [, $dsn] = coverageDatabase();
        $db = coverageConnect($dsn);
        try {
            coverageWant(!installedTable($db, 'coverage_install_missing'), 'coverage_install_missing exists before the case');
            $partial = RuntimeModel::build(RuntimeModel::parse(['partial.dbs' => PARTIAL_DOCUMENT]));
            $code = coverageCode(fn() => $db->utils()->schema()->install(new Schema($partial->manifestText, $partial->manifestHash)));
            coverageWant($code === Code::CONFIG, "a partly installed document set is $code, want CONFIG");
            coverageWant(!installedTable($db, 'coverage_install_missing'), 'the rejected install created coverage_install_missing');
        } finally {
            $db->close();
        }
    },
    // 외부 문서를 쓰는 set의 연결은 외부 table을 database에서 확인한다. 같은 table이면 연결하고, 외부
    // 문서의 column이 database에 없으면 연결과 install이 CONFIG이며 소유한 table을 만들지 않는다.
    'schema_install_external_documents' => function (): void {
        [, $dsn] = coverageDatabase();
        $schema = static function (string $external): Schema {
            $m = RuntimeModel::build(RuntimeModel::parseSet(['coverage_external.dbs' => EXTERNAL_MEMBER], ['bench_user.dbs' => $external]));
            return new Schema($m->manifestText, $m->manifestHash, $m->externalText);
        };
        Orm::connectSchema($dsn, $schema(EXTERNAL_USER), new Config())->close();
        $drifted = $schema(str_replace("  name varchar(191)\n", "  name varchar(191)\n  coverage_missing varchar(8) null\n", EXTERNAL_USER));
        $want = 'the tables that the set uses from external documents differ from the database: column user.coverage_missing does not exist';
        $refused = static function (string $step, callable $f) use ($want): void {
            try {
                $f();
                $message = 'no error';
            } catch (OrmException $e) {
                if ($e->code_ === Code::CONFIG && str_contains($e->getMessage(), $want)) {
                    return;
                }
                $message = "{$e->code_} {$e->getMessage()}";
            }
            throw new RuntimeException("$step: $message, want CONFIG with $want");
        };
        $refused('connect with a drifted external table', static fn() => Orm::connectSchema($dsn, $drifted, new Config())->close());
        $db = coverageConnect($dsn);
        try {
            $refused('install with a drifted external table', static fn() => $db->utils()->schema()->install($drifted));
            coverageWant(!installedTable($db, 'coverage_external_post'), 'the rejected install created coverage_external_post');
        } finally {
            $db->close();
        }
    },
]);
