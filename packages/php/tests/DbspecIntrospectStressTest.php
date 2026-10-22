<?php

declare(strict_types=1);

// The shared 2000-table document from tests/dbspec/stress.mts rendered for
// SQLite, applied to a new file and introspected under the configured
// memory_limit: the document keeps its schema text and no object is
// unsupported.

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;

// A benchmark of make dbspec-stress-bench (group bench): its measurements go to stderr.
#[Large]
#[Group('bench')]
final class DbspecIntrospectStressTest extends TestCase
{
    // Requirements: DBS-102.
    public function testIntrospectStress(): void
    {
        // The case builds a document of 2000 tables (one node process), applies it to a SQLite file, and introspects
        // it. The introspection of 2000 tables needs more than the default 128M; kit's runner runs php without a memory
        // flag.
        ini_set('memory_limit', '512M');
        fwrite(STDERR, 'memoryLimit=' . ini_get('memory_limit') . "\n");
        $root = dirname(__DIR__, 3);
        $process = proc_open(
            ['node', "$root/tests/dbspec/stress.mts"],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes
        );
        Assert::assertTrue(is_resource($process), 'node tests/dbspec/stress.mts did not start');
        $text = stream_get_contents($pipes[1]);
        $errors = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $status = proc_close($process);
        Assert::assertFalse(
            $status !== 0 || $text === false || $text === '',
            "node tests/dbspec/stress.mts failed with status $status: $errors"
        );
        $parsed = Dbspec::parse($text, []);
        Assert::assertNotNull($parsed->document, 'the stress document does not parse');
        $rendered = Dbspec::render([$parsed->document], 'sqlite');
        Assert::assertNotNull($rendered->statements, 'the stress document does not render');
        $want = Dbspec::manifest([$parsed->document])->manifest?->schemaText ?? throw new RuntimeException(
            'the stress document has no manifest'
        );
        $path = sys_get_temp_dir() . '/dbspec_php_stress_' . getmypid() . '.sqlite';
        Assert::assertFalse(file_exists($path), "$path already exists");
        // The value for the check is set before introspection, so its memory is not measured.
        $statements = $rendered->statements;
        unset($parsed, $rendered, $text);
        try {
            $pdo = new PDO("sqlite:$path", null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $pdo->exec('BEGIN');
            foreach ($statements as $statement) {
                $pdo->exec($statement);
            }
            $pdo->exec('COMMIT');
            fwrite(STDERR, 'applied ' . count($statements) . ' statements' . "\n");
            unset($statements);
            $introspectStarted = hrtime(true);
            $result = Dbspec::introspect($pdo, 'sqlite', 'stress');
            $introspectMs = (hrtime(true) - $introspectStarted) / 1e6;
            Assert::assertSame([], $result->unsupported, 'unsupported objects: ' . count($result->unsupported));
            $got = Dbspec::manifest([$result->document])->manifest?->schemaText;
            Assert::assertSame($want, $got, 'the introspected schema text differs from the stress document');
        } finally {
            $pdo = null;
            foreach (['', '-journal', '-wal', '-shm'] as $suffix) {
                if (file_exists($path . $suffix) && !unlink($path . $suffix)) {
                    throw new RuntimeException("$path$suffix cannot be removed");
                }
            }
        }
        fwrite(STDERR, 'introspectMs=' . round($introspectMs, 1) . ' peakBytes=' . memory_get_peak_usage(true) . "\n");
    }
}
