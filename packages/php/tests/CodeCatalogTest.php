<?php

declare(strict_types=1);

// Code.php, which orm-gen errors generates, compared with docs/spec/errors.yaml: every code is a constant whose doc
// comment is the note of the catalog (the origin, then ": " and the comment of the code), and the class holds no other
// code.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/CodeCatalogTest.php

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class CodeCatalogTest extends TestCase
{
    /** @return list<array{string, string}> each code of docs/spec/errors.yaml with its note */
    private static function catalog(): array
    {
        $out = [];
        $comment = '';
        foreach (explode("\n", (string) file_get_contents(__DIR__ . '/../../../docs/spec/errors.yaml')) as $line) {
            $text = trim($line);
            if (str_starts_with($text, '- code:')) {
                $parts = explode('#', trim(substr($text, strlen('- code:'))), 2);
                $out[] = [trim($parts[0]), ''];
                $comment = trim($parts[1] ?? '');
            } elseif (str_starts_with($text, 'origin:') && $out !== []) {
                $note = trim(substr($text, strlen('origin:')));
                $out[count($out) - 1][1] = $comment === '' ? $note : "$note: $comment";
            }
        }
        self::assertNotSame([], $out, 'docs/spec/errors.yaml lists no codes');
        return $out;
    }

    // Requirements: INT-65.
    public function test_catalog_matches_errors_yaml(): void
    {
        $source = (string) file_get_contents(__DIR__ . '/../src/Code.php');
        $codes = self::catalog();
        foreach ($codes as [$code, $note]) {
            $found = preg_match(
                '/\/\*\* (.*) \*\/\n\s*public const ' . preg_quote(
                    $code,
                    '/'
                ) . " = '" . preg_quote($code, '/') . "';/",
                $source,
                $m
            );
            self::assertSame(1, $found, "Code.php has no constant for $code");
            self::assertSame(
                $note,
                $m[1],
                "Code.php $code differs from docs/spec/errors.yaml; run orm-gen errors --lang php"
            );
        }
        self::assertSame(
            count($codes),
            preg_match_all('/public const \w+ = /', $source),
            'Code.php holds other codes than docs/spec/errors.yaml'
        );
        // Polyspec\Orm\Code is the class of the loaded code: the library's Code.php, or the class the polyspec_orm
        // extension registers.
        $codes = array_column($codes, 0);
        $declared = (new \ReflectionClass(\Polyspec\Orm\Code::class))->getConstants();
        self::assertEqualsCanonicalizing(
            array_combine($codes, $codes),
            $declared,
            'Polyspec\Orm\Code does not hold the codes of docs/spec/errors.yaml, each with its code as value'
        );
    }
}
