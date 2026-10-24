<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Collection;
use Polyspec\Orm\Model;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\User;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use ReflectionMethod;

#[Medium]
final class CoverageModelQueriesExtensionTest extends TestCase
{
    // Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-80, DSL-82, DSL-99, PLN-11.
    public function testModelQueryRows(): void
    {
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'gets'))->isInternal());
        Assert::assertTrue((new ReflectionClass(Collection::class))->isInternal());
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                $count = (new Author())($db)->userSeq(1)->getCount();
                Assert::assertSame(20, $count, "author count of user_seq 1 is $count, want 20");
                $names = array_map(
                    static fn(Author $author): string => $author->getName(),
                    (new Author())($db)->serviceSeq(7)->orderBySeqDesc()->limit(0, 3)->gets()->all()
                );
                Assert::assertSame(['author-99906', 'author-99806', 'author-99706'], $names);
                $sum = (new Author())($db)->serviceSeq(7)->sumReadCount()->getSum();
                Assert::assertSame(456000.0, $sum);
                $author = (new Author())($db)->relation(
                    (new User())->matchUserSeqWithSeq()->aliasWriter()
                )->getBySeq(5000);
                $writer = $author->getWriter();
                Assert::assertInstanceOf(User::class, $writer);
                Assert::assertSame('user-1', $writer->getName());
            } finally {
                $db->close();
            }
        }
    }
}
