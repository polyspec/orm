<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class CoverageHotPathReadCorrectnessTest extends TestCase
{
    public function testHotPathReadCorrectness(): void
    {
        // Requirements: PRT-2, PRT-34.
        hotPathReadCorrectness();
    }
}
