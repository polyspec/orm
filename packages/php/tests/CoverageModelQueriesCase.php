<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Db;
use Polyspec\Orm\StatementEvent;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\ServiceMember;
use Polyspec\Orm\Tests\Model\User;
use PHPUnit\Framework\Assert;

final class CoverageModelQueriesCase
{
    public static function run(Db $db): void
    {
        Assert::assertNull((new Author())($db)->seq(-1)->get(), 'get for a missing author');
        $count = (new Author())($db)->userSeq(1)->getCount();
        Assert::assertSame(20, $count, "author count for user_seq 1 is $count");

        $names = array_map(
            static fn(Author $author): string => $author->getName(),
            (new Author())($db)->serviceSeq(7)->orderBySeqDesc()->limit(0, 3)->gets()->all()
        );
        Assert::assertSame(['author-99906', 'author-99806', 'author-99706'], $names, 'ordered limited author rows');

        $query = (new Author())($db)->serviceSeq(7)->orderBySeqDesc();
        $page = $query->getsPage(1, 3);
        $pageNames = array_map(static fn(Author $author): string => $author->getName(), $page->items->all());
        Assert::assertSame($names, $pageNames, 'first page contains the first ordered rows');
        Assert::assertSame($query->getCount(), $page->totalCount, 'page total matches getCount');

        // A page past the first row binds its offset and count as integers (PRT-78): MySQL refuses a quoted LIMIT.
        $page = array_map(
            static fn(Author $author): string => $author->getName(),
            (new Author())($db)->serviceSeq(7)->orderBySeqDesc()->limit(1, 2)->gets()->all()
        );
        Assert::assertSame(['author-99806', 'author-99706'], $page, 'author rows of the page at offset 1');

        $sum = (new Author())($db)->serviceSeq(7)->sumReadCount()->getSum();
        Assert::assertSame(456000.0, $sum, "read_count sum of service_seq 7 is $sum");

        $joinSql = '';
        $unsubscribe = $db->subscribe(static function (StatementEvent $event) use (&$joinSql): void {
            if ($event->kind === StatementEvent::SELECT) {
                $joinSql = $event->sql;
            }
        });
        $joined = (new Author())($db)
            ->joinServiceMemberSeqWithSeq((new ServiceMember())->forceIndexIxServiceMemberService())
            ->joinUserSeqWithSeq(
                (new User())
                    ->addColumnReadTotal(fn(User $user) => (new Author())->sumReadCount()->userSeqEqSeq($user))
                    ->orderBySeqDesc()
            )
            ->gets();
        $unsubscribe();
        if ($db->driver() === 'sqlite') {
            Assert::assertStringContainsString('INDEXED BY "ix_service_member_service"', $joinSql, 'joined table forceIndex');
        } elseif ($db->driver() === 'mysql') {
            Assert::assertStringContainsString('FORCE INDEX (`ix_service_member_service`)', $joinSql, 'joined table forceIndex');
        }
        $joinedRows = $joined->all();
        Assert::assertNotEmpty($joinedRows, 'joined query returns authors');
        $previousUserSeq = null;
        foreach ($joinedRows as $author) {
            $user = $author->getUserModel();
            Assert::assertInstanceOf(User::class, $user, 'joined user');
            $userSeq = $user->getSeq();
            if ($previousUserSeq !== null) {
                Assert::assertLessThanOrEqual($previousUserSeq, $userSeq, 'joined order');
            }
            $previousUserSeq = $userSeq;
            Assert::assertEquals(
                (new Author())($db)->userSeq($userSeq)->sumReadCount()->getSum(),
                $user->getReadTotal(),
                'joined aggregate'
            );
        }

        $author = (new Author())($db)->relation((new User())->matchUserSeqWithSeq()->aliasWriter())->getBySeq(5000);
        $writer = $author->getWriter();
        Assert::assertInstanceOf(User::class, $writer);
        Assert::assertSame('user-1', $writer->getName(), 'related author writer');
    }
}
