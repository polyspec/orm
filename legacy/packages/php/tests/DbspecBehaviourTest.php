<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// Requirements: DBS-172.

// The PHP dbspec behavior cases compare with outcomes recorded from the PHP library in fixtures/dbspec-behaviour.json.
// The extension test package also runs its database-free cases through DbspecBehaviourNativeTest; the extension
// behavior target retains all cases.

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\DataProviderExternal;
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
    public function testCase(string $name): void
    {
        dbspec_behaviour_assert_case($name);
    }

    // Requirements: DBS-172.
    #[DataProviderExternal(BehaviourScriptedPdo::class, 'pureCaseProvider')]
    public function testPureCase(string $name): void
    {
        dbspec_behaviour_assert_case($name);
    }

    // Every recorded case is still a case, so a removed case does not leave its record behind.
    public function testRecordsAreCases(): void
    {
        Assert::assertSame(
            [],
            array_values(array_diff(array_keys(dbspec_behaviour_recorded()), array_keys(dbspec_behaviour_cases()))),
            'recorded outcomes of no case'
        );
    }
}
