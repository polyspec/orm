<?php

declare(strict_types=1);

// constraints_and_relations feature coverage: deleting a referenced row, a check violation,
// and unique duplicates fail with FOREIGN_KEY, CONSTRAINT, and DUPLICATE_KEY respectively, and no row
// is changed.

require_once __DIR__ . '/coverage_cases.php';

use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\User;
use Polyspec\Orm\Code;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class CoverageConstraintsAndRelationsTest extends TestCase
{
    public function test_constraint_errors(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                $before = (new Author())($db)->getBySeq(1)->toArray();
                $code = coverageCode(fn() => (new User())($db)->setSeq(1)->delete());
                Assert::assertTrue($code === Code::FOREIGN_KEY, "delete of a referenced user is $code, want FOREIGN_KEY");
                Assert::assertTrue((new User())($db)->getBySeq(1)->getName() === 'user-1', 'the referenced user changed');
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
}
