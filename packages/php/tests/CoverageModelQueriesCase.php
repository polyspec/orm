<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Db;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\User;
use PHPUnit\Framework\Assert;

final class CoverageModelQueriesCase
{
    public static function run(Db $db): void
    {
        $count = (new Author())($db)->userSeq(1)->getCount();
        Assert::assertSame(20, $count, "author count for user_seq 1 is $count");

        $names = array_map(
            static fn(Author $author): string => $author->getName(),
            (new Author())($db)->serviceSeq(7)->orderBySeqDesc()->limit(0, 3)->gets()->all()
        );
        Assert::assertSame(['author-99906', 'author-99806', 'author-99706'], $names, 'ordered limited author rows');

        $sum = (new Author())($db)->serviceSeq(7)->sumReadCount()->getSum();
        Assert::assertSame(456000.0, $sum, "read_count sum of service_seq 7 is $sum");

        $author = (new Author())($db)->relation((new User())->matchUserSeqWithSeq()->aliasWriter())->getBySeq(5000);
        $writer = $author->getWriter();
        Assert::assertInstanceOf(User::class, $writer);
        Assert::assertSame('user-1', $writer->getName(), 'related author writer');
    }
}
