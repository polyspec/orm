<?php

// The shared cases of contracts/fixtures/insert_parts.json, each a data set named by its id: Db::insertParts splits the
// rows of the case into the parts of its driver and column count (docs/spec/protocol.md "Multi-row inserts").
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/InsertPartsTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Db;

#[Small]
final class InsertPartsTest extends TestCase
{
    public static function cases(): iterable
    {
        $fixture = json_decode(
            (string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/insert_parts.json'),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
        foreach ($fixture['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    #[DataProvider('cases')]
    public function testCase(array $case): void
    {
        self::assertSame('insert_parts', $case['operation'], 'operation');
        self::assertSame($case['expected'], Db::insertParts($case['input']['rows'], $case['input']['batch']));
    }
}
