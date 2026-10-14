<?php
declare(strict_types=1);
// The hashes cases of tests/dbspec/cases.json and the repeated document name
// rule through Polyspec\Orm\Dbspec\Dbspec::manifest, and the sets cases through
// Dbspec::manifest and Dbspec::render in every dialect.
require_once __DIR__ . '/case_clock.php';
require_once dirname(__DIR__, 3) . '/tests/dbspec/cases.php';

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Document;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

/** @param list<string> $lines */
function manifest_text(array $lines): string
{
    return implode("\n", $lines) . "\n";
}

/** @param list<string> $lines */
function manifest_parsed(string $id, array $lines, array $set): Document
{
    $result = Dbspec::parse(manifest_text($lines), $set);
    Assert::assertNotNull($result->document, "$id: diagnostics " . json_encode(array_map(fn($d) => [$d->rule, $d->line, $d->column], $result->diagnostics)));
    return $result->document;
}

/** @param list<Document> $documents */
function manifest_expect(array $case, array $documents): void
{
    $result = Dbspec::manifest($documents);
    Assert::assertNotNull($result->manifest, "{$case['id']}: diagnostics " . json_encode(array_map(fn($d) => [$d->rule, $d->line, $d->column], $result->diagnostics)));
    $m = $result->manifest;
    foreach ([
        'manifestText' => [$m->manifestText, manifest_text($case['manifestText'])],
        'schemaText' => [$m->schemaText, manifest_text($case['schemaText'])],
        'manifestHash' => [$m->manifestHash, $case['manifestHash']],
        'schemaHash' => [$m->schemaHash, $case['schemaHash']],
    ] as $field => [$got, $want]) {
        Assert::assertSame($want, $got, "{$case['id']}: $field differs\n--- want\n$want\n--- got\n$got");
    }
}

/** 줄을 LF로 잇는다. 줄이 없으면 빈 text다. @param list<string> $lines */
function set_text(array $lines): string
{
    return $lines === [] ? '' : manifest_text($lines);
}

/**
 * statement 가운데 CREATE TABLE이 만드는 table 이름이다.
 *
 * @param list<string> $statements
 * @return list<string>
 */
function created_tables(array $statements): array
{
    $out = [];
    foreach ($statements as $statement) {
        if (str_starts_with($statement, 'CREATE TABLE ')) {
            $name = explode(' ', substr($statement, strlen('CREATE TABLE ')), 2)[0];
            $out[] = trim($name, '`"');
        }
    }
    return $out;
}

#[Small]
final class DbspecManifestTest extends TestCase
{
    private static array $started;

    public static function setUpBeforeClass(): void
    {
        self::$started = caseClockStart();
    }

    // 모든 case를 합친 CPU 시간이 10 s 기준값을 넘으면 경고한다.
    public static function tearDownAfterClass(): void
    {
        [$cpuMs, $wallMs] = caseClockElapsed(self::$started);
        if ($cpuMs > 10000) {
            caseClockWarning(sprintf('dbspec_manifest used %.3f ms of CPU (%.3f ms wall), above its reference of 10 s', $cpuMs, $wallMs));
        }
    }

    public static function hashesCases(): iterable
    {
        foreach (dbspec_read_cases()['hashes'] as $case) {
            yield 'hashes/' . $case['id'] => [$case];
        }
    }

    // 각 case는 memory 안에서 문서 집합 하나의 manifest와 hash를 만든다.
    #[DataProvider('hashesCases')]
    public function test_hashes(array $case): void
    {
        $names = array_keys($case['documents']);
        sort($names, SORT_STRING);
        $documents = [];
        foreach ($names as $name) {
            $set = [];
            foreach ($case['documents'] as $other => $lines) {
                if ($other !== $name) {
                    $set[$other] = manifest_text($lines);
                }
            }
            $documents[] = manifest_parsed("{$case['id']}/$name", $case['documents'][$name], $set);
        }
        manifest_expect($case, $documents);
        // The set is ordered by document name, not by the order given.
        manifest_expect($case, array_reverse($documents));
    }

    public static function setsCases(): iterable
    {
        foreach (dbspec_read_cases()['sets'] as $case) {
            yield 'sets/' . $case['id'] => [$case];
        }
    }

    #[DataProvider('setsCases')]
    public function test_sets(array $case): void
    {
        // 각 문서는 다른 소유 문서, 외부 문서(external), parsing 문서(헤더 이름이 키)를 집합으로 파싱한다.
        // 외부 문서는 external로 표시한다.
        $all = array_merge($case['documents'], $case['external'] ?? []);
        $owned = count($case['documents']);
        $names = [];
        foreach ($all as $i => $lines) {
            Assert::assertSame(1, preg_match('/\Adbspec 1 ([A-Za-z0-9_]+)\z/', $lines[0] ?? '', $m), "{$case['id']}: document $i has no header name");
            $names[$i] = $m[1];
        }
        $documents = [];
        foreach ($all as $i => $lines) {
            $set = array_map(manifest_text(...), $case['parsing']);
            foreach ($all as $j => $otherLines) {
                if ($j !== $i) {
                    $set[$names[$j]] = manifest_text($otherLines);
                }
            }
            $document = manifest_parsed("{$case['id']}/$i", $lines, $set);
            $document->external = $i >= $owned;
            $documents[] = $document;
        }
        $want = array_map(fn($e) => [$e['rule'], $e['line'], $e['column']], $case['errors']);
        $result = Dbspec::manifest($documents);
        $got = array_map(fn($d) => [$d->rule, $d->line, $d->column], $result->diagnostics);
        Assert::assertSame($want, $got, "{$case['id']}: manifest diagnostics");
        Assert::assertSame($want === [], $result->manifest !== null, "{$case['id']}: a manifest is returned exactly when no diagnostic is expected");
        $expected = $case['manifest'] ?? null;
        if ($expected !== null) {
            $m = $result->manifest;
            foreach ([
                'manifestText' => [$m->manifestText, set_text($expected['manifestText'])],
                'externalText' => [$m->externalText, set_text($expected['externalText'])],
                'schemaText' => [$m->schemaText, set_text($expected['schemaText'])],
                'manifestHash' => [$m->manifestHash, $expected['manifestHash']],
                'schemaHash' => [$m->schemaHash, $expected['schemaHash']],
            ] as $field => [$gotText, $wantText]) {
                Assert::assertSame($wantText, $gotText, "{$case['id']}: $field differs\n--- want\n$wantText\n--- got\n$gotText");
            }
        }
        foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
            $rendered = Dbspec::render($documents, $dialect);
            $got = array_map(fn($d) => [$d->rule, $d->line, $d->column], $rendered->diagnostics);
            Assert::assertSame($want, $got, "{$case['id']}/$dialect: render diagnostics");
            Assert::assertSame($want === [], $rendered->statements !== null, "{$case['id']}/$dialect: statements are returned exactly when no diagnostic is expected");
            if ($expected !== null) {
                Assert::assertSame($expected['created'], created_tables($rendered->statements), "{$case['id']}/$dialect: render creates");
            }
        }
    }

    public function test_repeated_name(): void
    {
        $text = ['dbspec 1 shop', '', 'table users {', '  id i64 identity', '  primary key (id)', '}'];
        $result = Dbspec::manifest([manifest_parsed('repeated', $text, []), manifest_parsed('repeated', $text, [])]);
        $got = array_map(fn($d) => [$d->rule, $d->line, $d->column], $result->diagnostics);
        $this->assertNull($result->manifest, 'repeated document name');
        $this->assertSame([['name.duplicate', 1, 10]], $got, 'repeated document name');
    }
}
