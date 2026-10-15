<?php
declare(strict_types=1);
// The sets cases of tests/dbspec/cases.json, shared by the PHP client's DbspecManifestTest and the extension's
// DbspecSetsTest (packages/php-ext/tests): each implementation passes its Dbspec class.

use Polyspec\Orm\Dbspec\Dbspec;
use PHPUnit\Framework\Assert;

/** @param list<string> $lines */
function manifest_text(array $lines): string
{
    return implode("\n", $lines) . "\n";
}

/** @param list<string> $lines */
function manifest_parsed(string $id, array $lines, array $set, string $dbspec = Dbspec::class): object
{
    $result = $dbspec::parse(manifest_text($lines), $set);
    Assert::assertNotNull($result->document, "$id: diagnostics " . json_encode(array_map(fn($d) => [$d->rule, $d->line, $d->column], $result->diagnostics)));
    return $result->document;
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

/**
 * Runs one sets case of tests/dbspec/cases.json on $dbspec (the PHP client or the extension): each document is parsed
 * in the set of the others, the external ones marked, and Dbspec::manifest and Dbspec::render in every dialect give
 * the case's diagnostics, manifest and created tables.
 */
function dbspec_sets_check(string $dbspec, array $case): void
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
        $document = manifest_parsed("{$case['id']}/$i", $lines, $set, $dbspec);
        $document->external = $i >= $owned;
        $documents[] = $document;
    }
    $want = array_map(fn($e) => [$e['rule'], $e['line'], $e['column']], $case['errors']);
    $result = $dbspec::manifest($documents);
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
        $rendered = $dbspec::render($documents, $dialect);
        $got = array_map(fn($d) => [$d->rule, $d->line, $d->column], $rendered->diagnostics);
        Assert::assertSame($want, $got, "{$case['id']}/$dialect: render diagnostics");
        Assert::assertSame($want === [], $rendered->statements !== null, "{$case['id']}/$dialect: statements are returned exactly when no diagnostic is expected");
        if ($expected !== null) {
            Assert::assertSame($expected['created'], created_tables($rendered->statements), "{$case['id']}/$dialect: render creates");
        }
    }
}
