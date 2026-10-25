<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use Polyspec\Orm\Tests\Model\Author;
use ReflectionClass;

#[Medium]
final class CoverageParameterChunkingExtensionTest extends TestCase
{
    // Requirements: PLN-44.
    // PRT-76: split IN lists, duplicate removal, and unmergeable page rejection.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_root_in_chunking(): void
    {
        Assert::assertTrue((new ReflectionClass(Db::class))->isInternal());
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                $values = array_merge(range(1, 70000), range(1, 200), range(200001, 200100));
                $count = (new Author())($db)->seq($values)->getCount();
                Assert::assertSame(70000, $count, "count of the split IN list is $count, want 70000");
                $limited = coverageCode(fn() => (new Author())($db)->seq($values)->limit(0, 10)->gets());
                Assert::assertSame(Code::IR_INVALID, $limited, 'a limited split IN list is rejected');
            } finally {
                $db->close();
            }
        }
    }
}
