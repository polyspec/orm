<?php

declare(strict_types=1);

// schema_definition feature coverage: each case of contracts/fixtures/schema_definition.json
// runs on the PHP dbspec implementation (Polyspec\Orm\Dbspec\Dbspec): after parse, emit reproduces
// byte for byte, the manifest hash of the document set, the per-dialect rendered statements, the tokens of syntax
// analysis, formatting and its refusal, and the declaration positions of a parse.
// The same file runs these cases on the PHP extension polyspec_orm, loaded in its own process (make
// dbspec-php-extension-check), whose classes take the place of the client's.

require_once __DIR__ . '/coverage_cases.php';

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Document;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

/**
 * Reads the documents the fixture lists and parses each document within that set.
 *
 * @param list<string> $paths
 * @return array{array<string, string>, list<Document>} text by path and the parsed documents
 */
function fixtureDocuments(string $root, array $paths, string $dbspec = Dbspec::class): array
{
    $texts = [];
    $named = [];
    foreach ($paths as $path) {
        $text = file_get_contents("$root/$path");
        if ($text === false || preg_match('/\Adbspec 1 ([a-z][a-z0-9_]*)\n/', $text, $m) !== 1) {
            throw new RuntimeException("cannot read the dbspec document $path");
        }
        $texts[$path] = $text;
        $named[$m[1]] = $text;
    }
    $documents = [];
    foreach ($texts as $path => $text) {
        $result = $dbspec::parse($text, $named);
        if ($result->document === null) {
            throw new RuntimeException("$path: " . json_encode($result->diagnostics));
        }
        $documents[] = $result->document;
    }
    return [$texts, $documents];
}

/** @return array<string, mixed> the case in the fixture with the same id */
function fixtureCase(array $fixture, string $id, string $operation): array
{
    foreach ($fixture['cases'] as $case) {
        if ($case['id'] === $id) {
            Assert::assertTrue(
                $case['operation'] === $operation,
                "case $id has operation {$case['operation']}, want $operation"
            );
            return $case;
        }
    }
    throw new RuntimeException("schema_definition.json has no case $id");
}

#[Small]
class CoverageSchemaDefinitionTest extends TestCase
{
    /** The dbspec implementation the cases run on: the PHP client here, the extension in its subclass. */
    protected static function dbspec(): string
    {
        return Dbspec::class;
    }

    public function testDbspecEmitRoundTrip(): void
    {
        $dbspec = static::dbspec();
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/schema_definition.json");
        $case = fixtureCase($fixture, 'dbspec_emit_round_trip', 'parse_emit');
        Assert::assertTrue(
            $case['expected'] === ['identical' => true],
            'unexpected round trip expectation ' . json_encode($case['expected'])
        );
        [$texts, $documents] = fixtureDocuments($root, $case['input']['documents'], $dbspec);
        foreach (array_keys($texts) as $i => $path) {
            Assert::assertTrue($dbspec::emit($documents[$i]) === $texts[$path], "emit of $path differs from its text");
        }
    }

    public function testDbspecManifestHash(): void
    {
        $dbspec = static::dbspec();
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/schema_definition.json");
        $case = fixtureCase($fixture, 'dbspec_manifest_hash', 'manifest');
        [, $documents] = fixtureDocuments($root, $case['input']['documents'], $dbspec);
        $result = $dbspec::manifest($documents);
        Assert::assertTrue($result->manifest !== null, 'manifest diagnostics ' . json_encode($result->diagnostics));
        Assert::assertTrue(
            $result->manifest->manifestHash === $case['expected']['manifest_hash'],
            "manifest hash {$result->manifest->manifestHash}"
        );
    }

    public function testDbspecRenderDdl(): void
    {
        $dbspec = static::dbspec();
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/schema_definition.json");
        $case = fixtureCase($fixture, 'dbspec_render_ddl', 'render');
        [, $documents] = fixtureDocuments($root, $case['input']['documents'], $dbspec);
        Assert::assertTrue(
            array_keys($case['expected']) === ['mysql', 'postgres', 'sqlite'],
            'rendered dialects ' . json_encode(array_keys($case['expected']))
        );
        foreach ($case['expected'] as $dialect => $statements) {
            $result = $dbspec::render($documents, $dialect);
            Assert::assertTrue(
                $result->statements === $statements,
                "$dialect statements " . json_encode($result->statements)
            );
        }
    }

    public function testDbspecAnalyzeTokens(): void
    {
        $dbspec = static::dbspec();
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/schema_definition.json");
        $case = fixtureCase($fixture, 'dbspec_analyze_tokens', 'analyze');
        [$texts, $documents] = fixtureDocuments($root, $case['input']['documents'], $dbspec);
        foreach (array_keys($texts) as $i => $path) {
            $analysis = $dbspec::analyze($texts[$path], []);
            $parsed = $dbspec::parse($texts[$path], []);
            Assert::assertTrue(
                $analysis->diagnostics === [],
                "$path analysis diagnostics " . json_encode($analysis->diagnostics)
            );
            Assert::assertTrue(
                $dbspec::emit($analysis->document) === $dbspec::emit($documents[$i]),
                "$path: the analysis differs from the parsed document"
            );
            Assert::assertTrue(
                $analysis->positions == $parsed->positions,
                "$path: the analysis differs from the positions of the parse"
            );
            $tokens = array_map(
                static fn(object $t): array => [$t->line, $t->start, $t->end, $t->class],
                $analysis->tokens
            );
            Assert::assertTrue(
                $case['expected']['tokens'] !== [] && $tokens === $case['expected']['tokens'],
                "$path tokens " . json_encode($tokens)
            );
        }
    }

    public function testDbspecFormat(): void
    {
        $dbspec = static::dbspec();
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/schema_definition.json");
        $case = fixtureCase($fixture, 'dbspec_format', 'format');
        $result = $dbspec::format(implode("\n", $case['input']['text']) . "\n", []);
        Assert::assertTrue($result->diagnostics === [], 'format diagnostics ' . json_encode($result->diagnostics));
        Assert::assertTrue(
            $result->text === implode("\n", $case['expected']['text']) . "\n",
            "formatted text {$result->text}"
        );
        Assert::assertTrue(
            $dbspec::format($result->text, [])->text === $result->text,
            'the formatted text is not its own format'
        );
    }

    public function testDbspecFormatRefusal(): void
    {
        $dbspec = static::dbspec();
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/schema_definition.json");
        $case = fixtureCase($fixture, 'dbspec_format_refusal', 'format');
        $result = $dbspec::format(implode("\n", $case['input']['text']) . "\n", []);
        Assert::assertTrue($result->text === null, "a document with a diagnostic was rewritten: {$result->text}");
        $diagnostics = array_map(
            static fn(object $d): array => ['rule' => $d->rule, 'line' => $d->line, 'column' => $d->column],
            $result->diagnostics
        );
        Assert::assertTrue(
            $case['expected']['diagnostics'] !== [] && $diagnostics === $case['expected']['diagnostics'],
            'diagnostics ' . json_encode($diagnostics)
        );
    }

    public function testDbspecParsePositions(): void
    {
        $dbspec = static::dbspec();
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/schema_definition.json");
        $case = fixtureCase($fixture, 'dbspec_parse_positions', 'parse_positions');
        [$texts] = fixtureDocuments($root, $case['input']['documents'], $dbspec);
        foreach ($texts as $path => $text) {
            $parsed = $dbspec::parse($text, []);
            Assert::assertTrue(
                $parsed->positions !== null,
                "$path parse diagnostics " . json_encode($parsed->diagnostics)
            );
            $positions = array_map(
                static fn(object $p): array => [
                    'kind' => $p->kind,
                    'path' => $p->path,
                    'line' => $p->line,
                    'column' => $p->column
                ],
                $parsed->positions
            );
            Assert::assertTrue(
                $case['expected']['positions'] !== [] && $positions === $case['expected']['positions'],
                "$path positions " . json_encode($positions)
            );
        }
    }
}
