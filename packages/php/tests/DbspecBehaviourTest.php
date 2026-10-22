<?php

declare(strict_types=1);

// The PHP behaviours of the dbspec interface that the shared vectors do not fix (dbspec_behaviour.php), each case
// against the outcome recorded from the PHP library in fixtures/dbspec-behaviour.json. The same file checks the PHP
// library and, run with the extension loaded, the extension.
require_once __DIR__ . '/dbspec_behaviour.php';

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class DbspecBehaviourTest extends TestCase
{
    public static function cases(): iterable
    {
        foreach (array_keys(dbspec_behaviour_cases()) as $name) {
            yield $name => [$name];
        }
    }

    // Requirements: DBS-2, DBS-99, DBS-171.
    #[DataProvider('cases')]
    public function test_case(string $name): void
    {
        $recorded = dbspec_behaviour_recorded();
        Assert::assertArrayHasKey(
            $name,
            $recorded,
            "$name is not recorded; run php packages/php/testing/dbspec/behaviour.php"
        );
        $got = json_decode(
            json_encode(
                dbspec_behaviour_cases()[$name](),
                JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR
            ),
            true
        );
        Assert::assertSame($recorded[$name], $got, $name);
    }

    // Every recorded case is still a case, so a removed case does not leave its record behind.
    public function test_records_are_cases(): void
    {
        Assert::assertSame(
            [],
            array_values(array_diff(array_keys(dbspec_behaviour_recorded()), array_keys(dbspec_behaviour_cases()))),
            'recorded outcomes of no case'
        );
    }
}
