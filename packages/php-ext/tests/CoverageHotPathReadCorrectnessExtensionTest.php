<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Model;
use ReflectionMethod;

#[Small]
final class CoverageHotPathReadCorrectnessExtensionTest extends TestCase
{
    public function testHotPathReadCorrectness(): void
    {
        // Requirements: PRT-2, PRT-34.
        Assert::assertTrue((new ReflectionMethod(Model::class, 'gets'))->isInternal());
        hotPathReadCorrectness();
    }
}
