<?php
declare(strict_types=1);
// The hashes cases of tests/dbspec/cases.json and the repeated document name
// rule through Polyspec\Orm\Dbspec\Dbspec::manifest, and the sets cases through
// Dbspec::manifest and Dbspec::render in every dialect.
require_once __DIR__ . '/case_clock.php';
require_once dirname(__DIR__, 3) . '/tests/dbspec/cases.php';
require_once __DIR__ . '/dbspec_sets_cases.php';

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Document;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

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

#[Small]
final class DbspecManifestTest extends TestCase
{
    private static array $started;

    public static function setUpBeforeClass(): void
    {
        self::$started = caseClockStart();
    }

    // Warns if the CPU time of all cases together exceeds the 10 s baseline.
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
            yield $case['id'] => [$case];
        }
    }

    // Each case makes the manifest and hash of one document set in memory.
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
            yield $case['id'] => [$case];
        }
    }

    #[DataProvider('setsCases')]
    public function test_sets(array $case): void
    {
        dbspec_sets_check(Dbspec::class, $case);
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
