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
    public function testCatalogBuildFailureRemainsADiagnostic(): void
    {
        $clock = cpuCaseBegin(1.0);
        $case = self::catalogBuildFailureCase();
        $text = implode("\n", $case['mermaid']) . "\n";
        $result = Dbspec::importMermaid($text, $case['name']);
        self::assertNull($result->document);
        $got = array_map(
            static fn($diagnostic): array => [$diagnostic->rule, $diagnostic->line, $diagnostic->column],
            $result->diagnostics,
        );
        self::assertSame($case['errors'], $got);
        cpuCaseEnd('dbspec/mermaid/catalog-build-failure-is-diagnostic', $clock);
    }

    /** @return array{id: string, mermaid: list<string>, name: string, errors: list<array{string, int, int}>} */
    private static function catalogBuildFailureCase(): array
    {
        $path = dirname(__DIR__, 3) . '/tests/dbspec/mermaid.json';
        $vectors = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
        foreach ($vectors['invalid'] as $case) {
            if ($case['id'] === 'catalog-build-failure-is-diagnostic') {
                return $case;
            }
        }
        throw new \LogicException('Mermaid vectors are missing catalog-build-failure-is-diagnostic');
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
