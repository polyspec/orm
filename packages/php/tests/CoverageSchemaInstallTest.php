<?php

declare(strict_types=1);

// schema_install feature coverage: the bench manifest held by the generated model is
// installed again on an installed bench database and changes nothing, and a database with only some tables
// is not created: the install of a document set fails with CONFIG and creates no missing tables. The install of a set
// that uses external documents checks the external tables in the database, and registration does not read the database.


use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Schema;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

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

/** External document of the set that uses the bench database's table user as an external document. */
const EXTERNAL_USER = <<<'DBSPEC'
dbspec 1 bench_user

table user {
  seq i64 identity
  name varchar(191)
  primary key (seq)
}

DBSPEC;

/** Document that uses the user of EXTERNAL_USER and owns only coverage_external_post. */
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

/** Reads from the catalog whether the connection's database has the table. */
function installedTable(Db $db, string $table): bool
{
    $sql = match ($db->driver()) {
        'mysql' => 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        'postgres' => 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND '
            . 'table_name = ?',
        'sqlite' => "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
    };
    $st = $db->pdo()->prepare($sql);
    $st->execute([$table]);
    return (int) $st->fetchColumn() === 1;
}

#[Medium]
final class CoverageSchemaInstallTest extends TestCase
{
    // Requirements: DBS-108, SCH-7.
    public function testSchemaInstallExisting(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                Assert::assertTrue(installedTable($db, 'author'), 'the bench database has no author table');
                // Installs the schema value of the generated code.
                $db->utils()->schema()->install(\Polyspec\Orm\Tests\Model\schema());
            } finally {
                $db->close();
            }
        }
    }

    // Requirements: DBS-108, SCH-10.
    public function testSchemaInstallPartial(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                Assert::assertTrue(
                    !installedTable($db, 'coverage_install_missing'),
                    'coverage_install_missing exists before the case'
                );
                $partial = RuntimeModel::build(RuntimeModel::parse(['partial.dbs' => PARTIAL_DOCUMENT]));
                $code = coverageCode(
                    fn() => $db->utils()->schema()->install(new Schema($partial->manifestText, $partial->manifestHash))
                );
                Assert::assertTrue($code === Code::CONFIG, "a partly installed document set is $code, want CONFIG");
                Assert::assertTrue(
                    !installedTable($db, 'coverage_install_missing'),
                    'the rejected install created coverage_install_missing'
                );
            } finally {
                $db->close();
            }
        }
    }

    // The install of a set that uses external documents checks the external tables in the database. If an external
    // document's column is missing from the database, install is CONFIG and does not create the table it owns.
    // Registration does not read the database, so it connects with that set too.
    // Requirements: DBS-107, SCH-7.
    public function testSchemaInstallExternalDocuments(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $schema = static function (string $external): Schema {
                $m = RuntimeModel::build(
                    RuntimeModel::parseSet(
                        ['coverage_external.dbs' => EXTERNAL_MEMBER],
                        ['bench_user.dbs' => $external]
                    )
                );
                return new Schema($m->manifestText, $m->manifestHash, $m->externalText);
            };
            Orm::connectSchema($dsn, $schema(EXTERNAL_USER), new Config())->close();
            $drifted = $schema(
                str_replace(
                    "  name varchar(191)\n",
                    "  name varchar(191)\n  coverage_missing varchar(8) null\n",
                    EXTERNAL_USER
                )
            );
            $want = 'the tables that the set uses from external documents differ from the database: column '
                . 'user.coverage_missing does not exist';
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
            Orm::connectSchema($dsn, $drifted, new Config())->close();
            $db = coverageConnect($dsn);
            try {
                $refused(
                    'install with a drifted external table',
                    static fn() => $db->utils()->schema()->install($drifted)
                );
                Assert::assertTrue(
                    !installedTable($db, 'coverage_external_post'),
                    'the rejected install created coverage_external_post'
                );
            } finally {
                $db->close();
            }
        }
    }
}
