<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Model;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

#[Medium]
final class CoverageModelWritesExtensionTest extends TestCase
{
    // Requirements: DSL-104, INT-35, PRT-41.
    public function testCreateParts(): void
    {
        Assert::assertTrue((new ReflectionMethod(Model::class, 'creates'))->isInternal(), 'Model::creates is native');
        require_once dirname(__DIR__, 2) . '/php/tests/CoverageModelWritesCase.php';
        \Polyspec\Orm\Tests\CoverageModelWritesCase::createParts(__FILE__, 990003);
    }

    // Requirements: COD-11, COD-12, COD-15, COD-38, DIA-26.
    public function testModelWriteCycle(): void
    {
        self::onEachCoverageDatabase(static function ($db): void {
            \Polyspec\Orm\Tests\CoverageModelWritesCase::orderedJsonTextRoundTrip($db);
            \Polyspec\Orm\Tests\CoverageModelWritesCase::codecColumnsRoundTrip($db);
        });
    }
    // Requirements: DIA-26, COD-15.
    public function testOrderedJsonRepeatedMemberName(): void
    {
        self::onEachCoverageDatabase(static function ($db): void {
            \Polyspec\Orm\Tests\CoverageModelWritesCase::orderedJsonRepeatedMemberNameRoundTrip($db);
        });
    }

    /** Runs `$run` on a connection to the database of each coverage item of this file, and closes the connection. */
    private static function onEachCoverageDatabase(callable $run): void
    {
        require_once dirname(__DIR__, 2) . '/php/tests/CoverageModelWritesCase.php';
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                $run($db);
            } finally {
                $db->close();
            }
        }
    }
}
