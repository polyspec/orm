<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// model_writes feature coverage: createParts runs the batch behaviour of CompositeAccount natively, and the write
// cycle checks the ordered JSON text and the codec columns, which the model_writes recipe does not assert.

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

const WRITE_TENANT = 990002;

#[Medium]
final class CoverageModelWritesTest extends TestCase
{
    // Requirements: DSL-104, INT-35, PRT-41.
    public function testCreateParts(): void
    {
        require_once __DIR__ . '/CoverageModelWritesCase.php';
        CoverageModelWritesCase::createParts(__FILE__, WRITE_TENANT + 1);
    }

    // Requirements: COD-11, COD-12, COD-15, COD-38, DIA-26.
    public function testModelWriteCycle(): void
    {
        require_once __DIR__ . '/CoverageModelWritesCase.php';
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                CoverageModelWritesCase::orderedJsonTextRoundTrip($db);
                CoverageModelWritesCase::codecColumnsRoundTrip($db);
            } finally {
                $db->close();
            }
        }
    }
    // Requirements: DIA-26, COD-15.
    public function testOrderedJsonRepeatedMemberName(): void
    {
        require_once __DIR__ . '/CoverageModelWritesCase.php';
        coverageAssertEntryClassesAreInternal();
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                CoverageModelWritesCase::orderedJsonRepeatedMemberNameRoundTrip($db);
            } finally {
                $db->close();
            }
        }
    }
}
