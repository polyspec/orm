<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// Focused dbspec rules that tests/dbspec/cases.json does not cover yet. An
// expected error names its rule, its line and a needle: the column is the
// first occurrence of the needle in that line (in characters), or an integer.

use RuntimeException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;

/** @param list<array{0:string,1:int,2:string|int}> $errors */
function rules_case(string $id, array $lines, array $errors, array $others = []): array
{
    $documents = $others + ['shop' => $lines];
    $expected = [];
    foreach ($errors as [$rule, $line, $needle]) {
        if (is_int($needle)) {
            $column = $needle;
        } else {
            $text = $lines[$line - 1];
            $at = mb_strpos($text, $needle);
            if ($at === false) {
                throw new RuntimeException("$id: needle '$needle' is not in line $line");
            }
            $column = $at + 1;
        }
        $expected[] = ['rule' => $rule, 'line' => $line, 'column' => $column];
    }
    return ['id' => $id, 'documents' => $documents, 'main' => 'shop', 'errors' => $expected];
}

/** A table body with an identity key around the given lines. */
function users(array $columns, array $rest = []): array
{
    return array_merge(
        ['dbspec 1 shop', '', 'table users {', '  id i64 identity'],
        $columns,
        ['  primary key (id)'],
        $rest,
        ['}']
    );
}

/**
 * The generated documents of a limit case and the one diagnostic each must give: [text, [rule, line, column]].
 *
 * @return array{string, array{string, int, int}}
 */
/**
 * Parses the document in a process of its own with PHP's default memory limit (KSTD-5-58). Returns the exit status, the
 * error output, and the parse's document flag with the baseline and peak memory of that process.
 * @return array{status: int, error: string, document: bool, baseline: int, peak: int}
 */
function limit_columns_peak_run(string $text): array
{
    $process = proc_open(
        [PHP_BINARY, '-d', 'memory_limit=128M', ormLegacyRoot() . '/packages/php/tests/limit_columns_peak.php'],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes,
    );
    if (!is_resource($process)) {
        throw new \RuntimeException('the limit/columns peak process did not start');
    }
    fwrite($pipes[0], $text);
    fclose($pipes[0]);
    $out = (string) stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    $error = (string) stream_get_contents($pipes[2]);
    fclose($pipes[2]);
    $status = proc_close($process);
    $data = $status === 0 ? json_decode(trim($out), true, 512, JSON_THROW_ON_ERROR) : [];
    return [
        'status' => $status,
        'error' => $error,
        'document' => (bool) ($data['document'] ?? false),
        'baseline' => (int) ($data['baseline'] ?? 0),
        'peak' => (int) ($data['peak'] ?? 0),
    ];
}

// The limit cases parse generated documents of up to 32 MiB: each has a CPU reference of 20 s, and no clock ends it
// (phpunit.xml.dist sets enforceTimeLimit to false).
#[Large]
final class DbspecRulesTest extends TestCase
{
    private static array $started;

    public static function setUpBeforeClass(): void
    {
        self::$started = caseClockStart();
    }

    // Warns if the CPU time of all rule cases together exceeds the 60 s baseline.
    public static function tearDownAfterClass(): void
    {
        [$cpuMs, $wallMs] = caseClockElapsed(self::$started);
        if ($cpuMs > 60000) {
            caseClockWarning(
                sprintf('dbspec_rules used %.3f ms of CPU (%.3f ms wall), above its reference of 60 s', $cpuMs, $wallMs)
            );
        }
    }

    // Limits: generated documents, each with its own CPU reference.
    // Requirements: DBS-144, DBS-151, DBS-170.
    // The limit/columns document must parse within the memory that PHPUnit allows a process: its peak over the memory
    // held before the parse is below the bound, which is derived from three numbers. PHP's default memory_limit (128
    // MiB, 134217728 bytes) is the memory of the process that runs the test. The baseline is the memory the process
    // holds before the parse (memory_get_usage()). The margin of 16 MiB is what the process keeps for the rest of the
    // run. The bound is 128 MiB minus the baseline minus the margin. The test raises memory_limit to 256M so that a
    // peak above the bound fails the assertion, not the process. The parse runs in a process of its own with PHP's
    // default memory limit, so the memory of the test run does not change the bound (KSTD-5-58). T182-0-2-1.
    public function testLimitColumnsPeak(): void
    {
        [$text] = rules_limit('columns');
        $child = limit_columns_peak_run($text);
        $this->assertSame(0, $child['status'], 'the limit/columns parse did not finish: ' . $child['error']);
        $baseline = $child['baseline'];
        $bound = 134217728 - $baseline - 16777216;
        $peak = $child['peak'] - $baseline;
        $this->assertFalse($child['document'], 'the limit/columns document returned a document');
        $this->assertLessThan(
            $bound,
            $peak,
            sprintf(
                'the limit/columns case peaks at %d bytes above the baseline of %d bytes; '
                . 'the derived bound is %d bytes '
                . '(128 MiB 134217728 minus the baseline minus the 16 MiB margin 16777216)',
                $peak,
                $baseline,
                $bound
            )
        );
    }

    /**
     * The full run holds about 88 MB before this test runs, from the earlier tests. The same parse is measured with
     * that memory held, which is the order that fails in the full run (KSTD-5-58).
     */
    public function testLimitColumnsPeakAfterHeldMemory(): void
    {
        $held = str_repeat('x', 88 * 1024 * 1024);
        $this->testLimitColumnsPeak();
        $this->assertSame(88 * 1024 * 1024, strlen($held));
    }
}
