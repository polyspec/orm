<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;
use ReflectionMethod;

#[Large]
final class DbspecStressCanonicalNativeTest extends TestCase
{
    // Requirements: DBS-123.
    public function testStressDocumentRoundTripsCanonically(): void
    {
        self::assertTrue((new ReflectionMethod(Dbspec::class, 'parse'))->isInternal());
        self::assertTrue((new ReflectionMethod(Dbspec::class, 'emit'))->isInternal());

        // The canonical 2000-table document needs more than the CLI's default 128M, as the existing introspection
        // stress case does.
        ini_set('memory_limit', '512M');
        $text = dbspec_stress_document();
        $result = Dbspec::parse($text, []);
        self::assertSame([], $result->diagnostics, 'The generated stress document has no parse diagnostics');
        self::assertNotNull($result->document, 'The generated stress document parses');

        $document = $result->document;
        self::assertCount(2000, $document->tables, 'Stress document table count');
        $columns = 0;
        $foreignKeys = 0;
        foreach ($document->tables as $table) {
            $columns += count($table->columns);
            $foreignKeys += count($table->foreignKeys);
        }
        self::assertSame(60000, $columns, 'Stress document column count');
        self::assertSame(10000, $foreignKeys, 'Stress document foreign key count');

        $first = Dbspec::emit($document);
        $second = Dbspec::emit($document);
        self::assertSame($text, $first, 'emit(parse(stress)) reproduces the generated canonical document');
        self::assertSame($first, $second, 'Two emissions of the parsed stress document are identical');
    }
}
