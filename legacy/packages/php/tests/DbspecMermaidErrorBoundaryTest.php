<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Dbspec\Mermaid;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class DbspecMermaidErrorBoundaryTest extends TestCase
{
    public function testUnexpectedCatalogErrorKeepsIdentity(): void
    {
        $clock = cpuCaseBegin(1.0);
        $cause = new \RuntimeException('unexpected catalog failure');
        $build = new \ReflectionMethod(Mermaid::class, 'buildCatalogDocument');
        try {
            $build->invoke(null, static function () use ($cause): never {
                throw $cause;
            });
            self::fail('an unexpected catalog error was converted into a diagnostic');
        } catch (\RuntimeException $error) {
            self::assertSame($cause, $error);
        }
        cpuCaseEnd('dbspec/mermaid/unexpected-catalog-error-keeps-identity', $clock);
    }
}
