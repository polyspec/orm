<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class ParentSlotExpansionNativeTest extends TestCase
{
    // Requirements: DSL-153.
    public function testBareDollarInLiteralIsPreserved(): void
    {
        self::assertTrue(
            function_exists('expand_numbered_parent_slots_test'),
            'the parent-slot native-test extension must provide its test function',
        );
        self::assertSame(
            'SELECT \'$\' AS sign WHERE id = $1, $2 AND status = $3',
            \expand_numbered_parent_slots_test(),
        );
    }
}
