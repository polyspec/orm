<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// constraints_and_relations feature coverage: the constraint errors and the external relation are covered by the
// constraints and relations recipe (ConstraintsAndRelationsRecipeTest); the immutable write remains here.
// CFG-33: database constraints map to stable error codes and leave rejected rows unchanged.


use Polyspec\Orm\Code;
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
        coverageGenerateFixtureModels(
            'refusal.dbs',
            $document,
            $work,
            'Polyspec\\Orm\\Tests\\CoverageConstraints\\Refusal'
        );
        $generated = true;
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
                    $row = (new RefusedRow())($db)->setAmount(1)->create();
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
