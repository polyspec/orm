<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class DbspecBehaviourNativeTest extends TestCase
{
    /** @return iterable<string, array{string}> */
    public static function pureCases(): iterable
    {
        foreach (dbspec_behaviour_pure_case_names() as $name) {
            yield $name => [$name];
        }
    }

    // Requirements: DBS-172.
    #[DataProvider('pureCases')]
    public function testPureCase(string $name): void
    {
        dbspec_behaviour_assert_case($name);
    }
}
