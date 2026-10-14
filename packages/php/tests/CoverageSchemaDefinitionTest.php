<?php
declare(strict_types=1);
// schema_definition feature coverage: contracts/fixtures/schema_definition.json의
// 각 case를 PHP dbspec 구현(Polyspec\Orm\Dbspec\Dbspec)으로 실행한다: parse 후 emit의
// byte 단위 재현, document set의 manifest hash, dialect별 rendered statement, the tokens of syntax analysis,
// formatting and its refusal, and the declaration positions of a parse.

require_once __DIR__ . '/coverage_cases.php';

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Diagnostic;
use Polyspec\Orm\Dbspec\Document;
use Polyspec\Orm\Dbspec\Position;
use Polyspec\Orm\Dbspec\Token;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

/**
 * fixture가 나열한 문서를 읽고 각 문서를 그 집합 안에서 parse한다.
 *
 * @param list<string> $paths
 * @return array{array<string, string>, list<Document>} 경로별 text와 parse한 문서
 */
function fixtureDocuments(string $root, array $paths): array
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
        $result = Dbspec::parse($text, $named);
        if ($result->document === null) {
            throw new RuntimeException("$path: " . json_encode($result->diagnostics));
        }
        $documents[] = $result->document;
    }
    return [$texts, $documents];
}

/** @return array<string, mixed> fixture에서 id가 같은 case */
function fixtureCase(array $fixture, string $id, string $operation): array
{
    foreach ($fixture['cases'] as $case) {
        if ($case['id'] === $id) {
            Assert::assertTrue($case['operation'] === $operation, "case $id has operation {$case['operation']}, want $operation");
            return $case;
        }
    }
    throw new RuntimeException("schema_definition.json has no case $id");
}

#[Small]
final class CoverageSchemaDefinitionTest extends TestCase
{
    public function test_dbspec_emit_round_trip(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/schema_definition.json");
        $case = fixtureCase($fixture, 'dbspec_emit_round_trip', 'parse_emit');
        Assert::assertTrue($case['expected'] === ['identical' => true], 'unexpected round trip expectation ' . json_encode($case['expected']));
        [$texts, $documents] = fixtureDocuments($root, $case['input']['documents']);
        foreach (array_keys($texts) as $i => $path) {
            Assert::assertTrue(Dbspec::emit($documents[$i]) === $texts[$path], "emit of $path differs from its text");
        }
    }

    public function test_dbspec_manifest_hash(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/schema_definition.json");
        $case = fixtureCase($fixture, 'dbspec_manifest_hash', 'manifest');
        [, $documents] = fixtureDocuments($root, $case['input']['documents']);
        $result = Dbspec::manifest($documents);
        Assert::assertTrue($result->manifest !== null, 'manifest diagnostics ' . json_encode($result->diagnostics));
        Assert::assertTrue($result->manifest->manifestHash === $case['expected']['manifest_hash'], "manifest hash {$result->manifest->manifestHash}");
    }

    public function test_dbspec_render_ddl(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/schema_definition.json");
        $case = fixtureCase($fixture, 'dbspec_render_ddl', 'render');
        [, $documents] = fixtureDocuments($root, $case['input']['documents']);
        Assert::assertTrue(array_keys($case['expected']) === ['mysql', 'postgres', 'sqlite'], 'rendered dialects ' . json_encode(array_keys($case['expected'])));
        foreach ($case['expected'] as $dialect => $statements) {
            $result = Dbspec::render($documents, $dialect);
            Assert::assertTrue($result->statements === $statements, "$dialect statements " . json_encode($result->statements));
        }
    }

    public function test_dbspec_analyze_tokens(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/schema_definition.json");
        $case = fixtureCase($fixture, 'dbspec_analyze_tokens', 'analyze');
        [$texts, $documents] = fixtureDocuments($root, $case['input']['documents']);
        foreach (array_keys($texts) as $i => $path) {
            $analysis = Dbspec::analyze($texts[$path], []);
            $parsed = Dbspec::parse($texts[$path], []);
            Assert::assertTrue($analysis->diagnostics === [], "$path analysis diagnostics " . json_encode($analysis->diagnostics));
            Assert::assertTrue(Dbspec::emit($analysis->document) === Dbspec::emit($documents[$i]), "$path: the analysis differs from the parsed document");
            Assert::assertTrue($analysis->positions == $parsed->positions, "$path: the analysis differs from the positions of the parse");
            $tokens = array_map(static fn(Token $t): array => [$t->line, $t->start, $t->end, $t->class], $analysis->tokens);
            Assert::assertTrue($case['expected']['tokens'] !== [] && $tokens === $case['expected']['tokens'], "$path tokens " . json_encode($tokens));
        }
    }

    public function test_dbspec_format(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/schema_definition.json");
        $case = fixtureCase($fixture, 'dbspec_format', 'format');
        $result = Dbspec::format(implode("\n", $case['input']['text']) . "\n", []);
        Assert::assertTrue($result->diagnostics === [], 'format diagnostics ' . json_encode($result->diagnostics));
        Assert::assertTrue($result->text === implode("\n", $case['expected']['text']) . "\n", "formatted text {$result->text}");
        Assert::assertTrue(Dbspec::format($result->text, [])->text === $result->text, 'the formatted text is not its own format');
    }

    public function test_dbspec_format_refusal(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/schema_definition.json");
        $case = fixtureCase($fixture, 'dbspec_format_refusal', 'format');
        $result = Dbspec::format(implode("\n", $case['input']['text']) . "\n", []);
        Assert::assertTrue($result->text === null, "a document with a diagnostic was rewritten: {$result->text}");
        $diagnostics = array_map(static fn(Diagnostic $d): array => ['rule' => $d->rule, 'line' => $d->line, 'column' => $d->column], $result->diagnostics);
        Assert::assertTrue($case['expected']['diagnostics'] !== [] && $diagnostics === $case['expected']['diagnostics'], 'diagnostics ' . json_encode($diagnostics));
    }

    public function test_dbspec_parse_positions(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/schema_definition.json");
        $case = fixtureCase($fixture, 'dbspec_parse_positions', 'parse_positions');
        [$texts] = fixtureDocuments($root, $case['input']['documents']);
        foreach ($texts as $path => $text) {
            $parsed = Dbspec::parse($text, []);
            Assert::assertTrue($parsed->positions !== null, "$path parse diagnostics " . json_encode($parsed->diagnostics));
            $positions = array_map(static fn(Position $p): array => ['kind' => $p->kind, 'path' => $p->path, 'line' => $p->line, 'column' => $p->column], $parsed->positions);
            Assert::assertTrue($case['expected']['positions'] !== [] && $positions === $case['expected']['positions'], "$path positions " . json_encode($positions));
        }
    }
}
