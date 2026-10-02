<?php
declare(strict_types=1);
// schema_definition feature coverage: contracts/fixtures/schema_definition.json의
// 각 case를 PHP dbspec 구현(Orm\Dbspec\Dbspec)으로 실행한다: parse 후 emit의
// byte 단위 재현, document set의 manifest hash, dialect별 rendered statement.

require dirname(__DIR__) . '/vendor/autoload.php';
require __DIR__ . '/coverage_cases.php';

use Orm\Dbspec\Dbspec;
use Orm\Dbspec\Document;

$root = dirname(__DIR__, 3);
$fixture = coverageJson("$root/contracts/fixtures/schema_definition.json");

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
            coverageWant($case['operation'] === $operation, "case $id has operation {$case['operation']}, want $operation");
            return $case;
        }
    }
    throw new RuntimeException("schema_definition.json has no case $id");
}

runCoverageCases($argv, [
    'dbspec_emit_round_trip' => function () use ($root, $fixture): void {
        $case = fixtureCase($fixture, 'dbspec_emit_round_trip', 'parse_emit');
        coverageWant($case['expected'] === ['identical' => true], 'unexpected round trip expectation ' . json_encode($case['expected']));
        [$texts, $documents] = fixtureDocuments($root, $case['input']['documents']);
        foreach (array_keys($texts) as $i => $path) {
            coverageWant(Dbspec::emit($documents[$i]) === $texts[$path], "emit of $path differs from its text");
        }
    },
    'dbspec_manifest_hash' => function () use ($root, $fixture): void {
        $case = fixtureCase($fixture, 'dbspec_manifest_hash', 'manifest');
        [, $documents] = fixtureDocuments($root, $case['input']['documents']);
        $result = Dbspec::manifest($documents);
        coverageWant($result->manifest !== null, 'manifest diagnostics ' . json_encode($result->diagnostics));
        coverageWant($result->manifest->manifestHash === $case['expected']['manifest_hash'], "manifest hash {$result->manifest->manifestHash}");
    },
    'dbspec_render_ddl' => function () use ($root, $fixture): void {
        $case = fixtureCase($fixture, 'dbspec_render_ddl', 'render');
        [, $documents] = fixtureDocuments($root, $case['input']['documents']);
        coverageWant(array_keys($case['expected']) === ['mysql', 'postgres', 'sqlite'], 'rendered dialects ' . json_encode(array_keys($case['expected'])));
        foreach ($case['expected'] as $dialect => $statements) {
            $result = Dbspec::render($documents, $dialect);
            coverageWant($result->statements === $statements, "$dialect statements " . json_encode($result->statements));
        }
    },
]);
