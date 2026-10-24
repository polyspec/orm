<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// constraints_and_relations feature coverage: deleting a referenced row, a check violation,
// and unique duplicates fail with FOREIGN_KEY, CONSTRAINT, and DUPLICATE_KEY respectively, and no row
// is changed.
// CFG-33: database constraints map to stable error codes and leave rejected rows unchanged.


use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\NoteReader;
use Polyspec\Orm\Tests\Model\SharedNote;
use Polyspec\Orm\Tests\Model\User;
use Polyspec\Orm\Code;
use Polyspec\Orm\Generator;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Tests\CoverageConstraints\Refusal\RefusedRow;
use PDOException;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class CoverageConstraintsAndRelationsTest extends TestCase
{
    private static function refusalModels(): void
    {
        static $generated = false;
        if ($generated) {
            return;
        }
        $root = dirname(__DIR__, 3);
        $document = file_get_contents("$root/contracts/fixtures/refusal.dbs");
        Assert::assertIsString($document, 'refusal.dbs is readable');
        $work = sys_get_temp_dir() . '/orm-php-coverage-refusal-' . getmypid();
        Assert::assertTrue(!is_dir($work) && mkdir($work, 0o700, true), "cannot create $work");
        register_shutdown_function(static function () use ($work): void {
            exec('rm -rf ' . escapeshellarg($work), $output, $status);
            if ($status !== 0) {
                fwrite(STDERR, "cannot remove $work\n");
                exit(1);
            }
        });
        Generator::generate(
            RuntimeModel::build(RuntimeModel::parse(['refusal.dbs' => $document])),
            "$work/gen",
            'Polyspec\\Orm\\Tests\\CoverageConstraints\\Refusal'
        );
        requireGeneratedClasses("$work/gen");
        require_once "$work/gen/bootstrap.php";
        $generated = true;
    }

    public function testConstraintErrors(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                $before = (new Author())($db)->getBySeq(1)->toArray();
                $code = coverageCode(fn() => (new User())($db)->setSeq(1)->delete());
                Assert::assertTrue(
                    $code === Code::FOREIGN_KEY,
                    "delete of a referenced user is $code, want FOREIGN_KEY"
                );
                Assert::assertTrue(
                    (new User())($db)->getBySeq(1)->getName() === 'user-1',
                    'the referenced user changed'
                );
                $code = coverageCode(fn() => (new Author())($db)->setSeq(1)->setLikeCount(-1)->update());
                Assert::assertTrue($code === Code::CONSTRAINT, "a negative like_count is $code, want CONSTRAINT");
                $uuid = (new Author())($db)->getBySeq(2)->getUuid();
                Assert::assertTrue(is_string($uuid) && $uuid !== '', 'author 2 has no uuid');
                $code = coverageCode(fn() => (new Author())($db)->setSeq(1)->setUuid($uuid)->update());
                Assert::assertTrue($code === Code::DUPLICATE_KEY, "a duplicate uuid is $code, want DUPLICATE_KEY");
                $after = (new Author())($db)->getBySeq(1)->toArray();
                Assert::assertTrue($after === $before, 'author 1 changed: ' . json_encode($after));
            } finally {
                $db->close();
            }
        }
    }

    public function testExternalRelation(): void
    {
        coverageAssertEntryClassesAreInternal();
        if (getenv('ORM_PHP_MODE') === 'extension') {
            Assert::assertTrue(
                (new \ReflectionClass(\Polyspec\Orm\Model::class))->isInternal(),
                'relation queries use the native extension Model class'
            );
        }
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                $got = [];
                $rows = (new NoteReader())($db)
                    ->relation((new SharedNote())->matchSharedNoteSeqWithSeq())
                    ->orderBySeqAsc()
                    ->gets();
                foreach ($rows as $row) {
                    $note = $row->getSharedNoteModel();
                    Assert::assertInstanceOf(SharedNote::class, $note);
                    $got[] = $row->getSeq() . ':' . $note->getTitle();
                }
                Assert::assertSame(
                    ['1:note-1', '2:note-1', '3:note-3'],
                    $got,
                    'relation reads the external shared_note document'
                );
            } finally {
                $db->close();
            }
        }
    }

    // DBS-84: renderer-installed immutable write triggers reject updates without changing stored rows.
    public function testImmutableWrite(): void
    {
        coverageAssertEntryClassesAreInternal();
        if (getenv('ORM_PHP_MODE') === 'extension') {
            Assert::assertTrue(
                (new \ReflectionClass(\Polyspec\Orm\Model::class))->isInternal(),
                'Model writes use the native extension class'
            );
        }
        self::refusalModels();
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                Assert::assertFalse(coverageTableExists($db, 'refused_row'), 'refused_row exists before the case');
                coverageRestoring(function () use ($db): void {
                    $db->utils()->schema()->install(\Polyspec\Orm\Tests\CoverageConstraints\Refusal\schema());
                    $row = (new RefusedRow())->setAmount(1)->create();
                    try {
                        $row->setAmount(2)->update();
                        Assert::fail('an immutable row update must fail');
                    } catch (OrmException $error) {
                        Assert::assertSame(Code::DRIVER, $error->code_, 'immutable update code');
                        Assert::assertStringContainsString('table refused_row is immutable', $error->getMessage());
                        Assert::assertInstanceOf(PDOException::class, $error->getPrevious());
                    }
                    $stored = (new RefusedRow())($db)->getBySeq($row->getSeq());
                    Assert::assertSame(1, $stored->getAmount(), 'immutable row value changed');
                }, function () use ($db): void {
                    $db->pdo()->exec('DROP TABLE IF EXISTS refused_row');
                    if ($db->driver() === 'postgres') {
                        $db->pdo()->exec('DROP FUNCTION IF EXISTS "refused_row$immutable_update"()');
                        $db->pdo()->exec('DROP FUNCTION IF EXISTS "refused_row$immutable_delete"()');
                    }
                });
                Assert::assertFalse(coverageTableExists($db, 'refused_row'), 'refused_row remains after the case');
            } finally {
                $db->close();
            }
        }
    }
}
