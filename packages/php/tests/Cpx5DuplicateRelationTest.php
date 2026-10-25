<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\TestCase;

final class Cpx5DuplicateRelationTest extends TestCase
{
    use Cpx5DuplicateRelationCases;

    // Requirements: CPX-5, DSL-128.
    public function testGetQueryRejectsDuplicateRelationWithAliasHint(): void
    {
        $this->assertDuplicateRelationAliasHint('orm-cpx5-');
    }
}
