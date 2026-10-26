<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Tests\Model\Author;

#[Small]
final class ParentSlotPaddingTest extends TestCase
{
    use DatabaseTestAssertions;

    // Requirements: PRT-40.
    public function testTuplePredicatePadsByRepeatingTheLastRow(): void
    {
        $this->assertTuplePredicatePadsByRepeatingLastRow(new Author());
    }
}
