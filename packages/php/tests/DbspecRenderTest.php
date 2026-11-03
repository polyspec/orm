<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The statement vectors of tests/dbspec/ddl.json through
// Polyspec\Orm\Dbspec\Dbspec::render.

use RuntimeException;
use PDO;
use PDOException;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;

#[Small]
class DbspecRenderTest extends TestCase
{
    use DbspecTimedCases;

    // The statements that every client runs on a new connection (docs/spec/dialects.md "Foreign keys").
    private const CONNECTION_RULES = [
        'mysql' => ["SET time_zone = '+00:00'"],
        'postgres' => ["SET TimeZone = 'UTC'"],
        'sqlite' => ['PRAGMA foreign_keys = ON'],
    ];

    protected static function timingName(): string
    {
        return 'dbspec_render';
    }

    /** @param list<string> $lines */
    private static function text(array $lines): string
    {
        return implode("\n", $lines) . "\n";
    }

    public static function ddlCases(): iterable
    {
        $vectors = json_decode(
            file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/ddl.json'),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
        if (($vectors['cases'] ?? []) === []) {
            throw new RuntimeException('Missing ddl vectors');
        }
        foreach ($vectors['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    // Each vector renders one document in memory in three dialects.
    #[DataProvider('ddlCases')]
    public function testDdl(array $case): void
    {
        $documents = [];
        foreach ($case['documents'] as $name => $lines) {
            $set = [];
            foreach ($case['documents'] as $other => $otherLines) {
                if ($other !== $name) {
                    $set[$other] = self::text($otherLines);
                }
            }
            $result = Dbspec::parse(self::text($lines), $set);
            $this->assertNotNull(
                $result->document,
                "{$case['id']}/$name: diagnostics " . json_encode(
                    array_map(fn($d) => [$d->rule, $d->line, $d->column, $d->message], $result->diagnostics)
                )
            );
            $documents[] = $result->document;
        }
        foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
            $this->assertArrayHasKey($dialect, $case['statements'], "{$case['id']}: no $dialect statements");
            $want = $case['statements'][$dialect];
            // The order of the document set does not change the result.
            foreach ([$documents, array_reverse($documents)] as $set) {
                $rendered = Dbspec::render($set, $dialect);
                $this->assertNotNull(
                    $rendered->statements,
                    "{$case['id']}/$dialect: diagnostics " . json_encode(
                        array_map(fn($d) => [$d->rule, $d->line, $d->column, $d->message], $rendered->diagnostics)
                    )
                );
                $this->assertSame($want, $rendered->statements, "{$case['id']}/$dialect: statements differ");
            }
        }
    }

    /** @return iterable<string, array{0: array}> the vectors that have behavior steps */
    public static function behaviourCases(): iterable
    {
        foreach (self::ddlCases() as $id => $data) {
            if (($data[0]['behavior'] ?? []) !== []) {
                yield $id => $data;
            }
        }
    }

    /**
     * Runs the behavior steps of each vector on a fresh MySQL database, PostgreSQL schema and SQLite file, after its
     * rendered statements. ORM_TEST_MYSQL_SERVER_DSN and ORM_TEST_POSTGRES_SERVER_DSN name the servers; the test fails
     * naming the one that is unset. Requirement: DIA-113 (check-recipes CR16-1-3).
     */
    #[DataProvider('behaviourCases')]
    #[Group('database')]
    public function testBehaviourPhysical(array $case): void
    {
        $dsns = dbspec_dsns([
            'mysql' => 'ORM_TEST_MYSQL_SERVER_DSN',
            'postgres' => 'ORM_TEST_POSTGRES_SERVER_DSN',
        ]);
        foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
            $this->runBehaviour($dialect, $case, $dsns[$dialect] ?? null);
        }
    }

    private function runBehaviour(string $dialect, array $case, ?string $serverDsn): void
    {
        static $run = 0;
        $run++;
        $name = sprintf('render_php_%d_%03d', getmypid(), $run);
        $options = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION];
        if ($dialect === 'sqlite') {
            $path = sys_get_temp_dir() . "/$name.sqlite";
            Assert::assertFalse(file_exists($path), "SQLite file $path already exists");
            $open = static fn(): PDO => new PDO("sqlite:$path", null, null, $options);
            $drop = static fn() => dbspec_remove_sqlite_files($path);
        } else {
            [$open, $drop] = dbspec_open_server_database($dialect, $name, $serverDsn);
        }
        try {
            $pdo = $open();
            foreach (self::CONNECTION_RULES[$dialect] as $rule) {
                $pdo->exec($rule);
            }
            foreach ($case['statements'][$dialect] as $statement) {
                $pdo->exec($statement);
            }
            foreach ($case['behavior'] as $step) {
                if (isset($step['dialects']) && !in_array($dialect, $step['dialects'], true)) {
                    continue;
                }
                if (array_key_exists('sql', $step)) {
                    if (!($step['fails'] ?? false)) {
                        $pdo->exec($step['sql']);
                        continue;
                    }
                    try {
                        $pdo->exec($step['sql']);
                    } catch (PDOException) {
                        continue;
                    }
                    Assert::fail("$dialect: {$step['sql']} must fail");
                }
                Assert::assertSame(
                    $step['want'],
                    dbspec_value($pdo, $step['query'], true),
                    "$dialect: {$step['query']}"
                );
            }
        } finally {
            $drop();
        }
    }

    // Requirements: DBS-174.
}
