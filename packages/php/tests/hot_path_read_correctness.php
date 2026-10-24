<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use PHPUnit\Framework\Assert;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Tests\Model\Author;
use RuntimeException;

function hotPathReadCorrectness(): void
{
    $path = tempnam(sys_get_temp_dir(), 'orm-hot-path-');
    if (!is_string($path) || $path === '') {
        throw new RuntimeException('cannot create a private SQLite hot-path fixture');
    }
    $native = null;
    $db = null;
    try {
        $native = new PDO('sqlite:' . $path);
        $native->exec('CREATE TABLE author (seq INTEGER PRIMARY KEY, name TEXT NOT NULL, service_seq INTEGER NOT NULL, is_close INTEGER NOT NULL)');
        $insert = $native->prepare('INSERT INTO author (seq, name, service_seq, is_close) VALUES (?, ?, ?, ?)');
        for ($seq = 1; $seq <= 100; $seq++) {
            $insert->execute([$seq, sprintf('list-%03d', $seq), 7, 0]);
        }
        $insert->execute([101, 'closed', 7, 1]);
        $insert->execute([102, 'other-service', 8, 0]);
        $db = Model\connect('sqlite://' . $path, new Config(aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index'));

        $pk = (new Author())($db)->removeAllColumns()->removeColumnUserSeq()->removeColumnServiceSeq()
            ->removeColumnServiceRegionSeq()->removeColumnServiceMemberSeq()->seq(42)->addColumnSeq()->addColumnName()->limit(0, 1);
        $pkStatement = $pk->getQuery();
        Assert::assertSame([42, 1, 0], $pkStatement['binds'], 'PK binds');
        assertHotPathProjection($pkStatement['sql']);
        $pkExpected = [[42, 'list-042']];
        Assert::assertSame($pkExpected, hotPathNativeRows($native, $pkStatement['sql'], $pkStatement['binds']), 'PK native rows');
        Assert::assertSame($pkExpected, hotPathClientRows($pk->gets()->all()), 'PK client rows');

        $list = (new Author())($db)->removeAllColumns()->removeColumnUserSeq()->removeColumnServiceSeq()
            ->removeColumnServiceRegionSeq()->removeColumnServiceMemberSeq()->serviceSeq(7)->andIsClose(false)
            ->orderBySeqDesc()->limit(0, 100)->addColumnSeq()->addColumnName();
        $listStatement = $list->getQuery();
        Assert::assertSame([7, false, 100, 0], $listStatement['binds'], 'list100 binds');
        assertHotPathProjection($listStatement['sql']);
        $expected = [];
        for ($seq = 100; $seq >= 1; $seq--) {
            $expected[] = [$seq, sprintf('list-%03d', $seq)];
        }
        Assert::assertSame($expected, hotPathNativeRows($native, $listStatement['sql'], $listStatement['binds']), 'list100 native rows');
        Assert::assertSame($expected, hotPathClientRows($list->gets()->all()), 'list100 client rows');
    } finally {
        if ($db instanceof Db) {
            $db->close();
        }
        $native = null;
        unlink($path);
    }
}

function assertHotPathProjection(string $sql): void
{
    $projection = explode(' FROM ', $sql, 2)[0];
    Assert::assertStringContainsString('"a"."seq" AS "a__seq"', $projection);
    Assert::assertStringContainsString('"a"."name" AS "a__name"', $projection);
    Assert::assertStringNotContainsString('created_ts', $projection);
    Assert::assertStringNotContainsString('service_seq', $projection);
}

/** @param list<mixed> $binds @return list<array{int, string}> */
function hotPathNativeRows(PDO $native, string $sql, array $binds): array
{
    $statement = $native->prepare($sql);
    foreach (array_values($binds) as $index => $value) {
        $type = is_bool($value) ? PDO::PARAM_BOOL : (is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
        $statement->bindValue($index + 1, $value, $type);
    }
    $statement->execute();
    return array_map(static fn(array $row): array => [(int) $row[0], (string) $row[1]], $statement->fetchAll(PDO::FETCH_NUM));
}

/** @param list<Author> $rows @return list<array{int, string}> */
function hotPathClientRows(array $rows): array
{
    return array_map(static fn(Author $row): array => [$row->getSeq(), $row->getName()], $rows);
}
