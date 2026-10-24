<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Mermaid;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class DbspecMermaidErrorBoundaryTest extends TestCase
{
    private const DIAGRAM = "erDiagram\n    account {\n        i64 id PK\n    }\n";

    public function testCatalogBuildFailureRemainsADiagnostic(): void
    {
        $clock = cpuCaseBegin(1.0);
        $result = Dbspec::importMermaid(self::DIAGRAM, 'invalid name');
        self::assertNull($result->document);
        self::assertCount(1, $result->diagnostics);
        self::assertSame(1, $result->diagnostics[0]->line);
        cpuCaseEnd('dbspec/mermaid/catalog-build-failure-is-diagnostic', $clock);
    }

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
