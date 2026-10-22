<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// parameter_chunking feature coverage: a root IN list longer than the bind limit of every driver
// is run in parts, duplicate values are read only once, and combining a split list with limit
// gives IR_INVALID.


use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Code;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class CoverageParameterChunkingTest extends TestCase
{
    // PRT-76: a root IN list longer than the bind limit is split into chunks, and a limit on the split list fails with
    // IR_INVALID.
    public function testRootInChunking(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                // seq 1..70000, duplicates of 1..200, and missing seqs 200001..200100.
                $values = array_merge(range(1, 70000), range(1, 200), range(200001, 200100));
                $count = (new Author())($db)->seq($values)->getCount();
                Assert::assertTrue($count === 70000, "count of the split IN list is $count, want 70000");
                $limited = coverageCode(fn() => (new Author())($db)->seq($values)->limit(0, 10)->gets());
                Assert::assertTrue(
                    $limited === Code::IR_INVALID,
                    "a limited split IN list is $limited, want IR_INVALID"
                );
            } finally {
                $db->close();
            }
        }
    }
}
