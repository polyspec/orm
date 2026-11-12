<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProviderExternal;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class DbspecBehaviourNativeTest extends TestCase
{
    // Requirements: DBS-172.
    #[DataProviderExternal(BehaviourScriptedPdo::class, 'pureCaseProvider')]
    public function testPureCase(string $name): void
    {
        dbspec_behaviour_assert_case($name);
    }
}
