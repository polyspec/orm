<?php
declare(strict_types=1);
// model_queries feature coverage: 생성된 bench model로 seed된 bench database를
// 읽는다(scripts/bench-db.sh). author seq i는 user_seq i%5000+1,
// service_seq i%100+1, read_count i%1000이고 user seq n의 name은 user-n이다.

require_once __DIR__ . '/coverage_cases.php';

use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\User;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class CoverageModelQueriesTest extends TestCase
{
    public function test_model_query_rows(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                $count = (new Author)($db)->userSeq(1)->getCount();
                Assert::assertTrue($count === 20, "author count of user_seq 1 is $count, want 20");
                $names = array_map(static fn(Author $b): string => $b->getName(),
                    (new Author)($db)->serviceSeq(7)->orderBySeqDesc()->limit(0, 3)->gets()->all());
                Assert::assertTrue($names === ['author-99906', 'author-99806', 'author-99706'], 'ordered limited rows ' . json_encode($names));
                $sum = (new Author)($db)->serviceSeq(7)->sumReadCount()->getSum();
                Assert::assertTrue($sum === 456000.0, "read_count sum of service_seq 7 is $sum, want 456000");
                $author = (new Author)($db)->relation((new User)->matchUserSeqWithSeq()->aliasWriter())->getBySeq(5000);
                $writer = $author->getWriter();
                Assert::assertTrue($writer instanceof User && $writer->getName() === 'user-1', 'user relation of author 5000 is ' . json_encode($writer?->toArray()));
            } finally {
                $db->close();
            }
        }
    }
}
