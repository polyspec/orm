<?php

declare(strict_types=1);

// Polyspec\Orm\Dbspec\Dbspec::introspect on MySQL, reading a canned catalog
// (T62-4-8). The double CannedCatalogPdo answers each catalog query of mysql_read with the rows of
// tests/dbspec/show-create.json ("catalog" and each case), so the reader of shown_check goes to SHOW CREATE TABLE
// for the body of the one CHECK. Each case expects the same checks and unsupported objects as the Go introspection
// of the same answers (packages/go/engine/dbspec show_create_introspect_test.go reads the same file), or the error of a
// CHECK the statement lacks.

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Unsupported;

/**
 * A PDO whose query() answers the catalog queries of MySQL introspection from the canned catalog. The rows are
 * returned by a statement of an in-memory SQLite database, so introspection reads them through the PDOStatement
 * API as it reads a MySQL connection.
 */
final class CannedCatalogPdo extends PDO
{
    /** @param array<string, mixed> $catalog */
    public function __construct(
        private readonly array $catalog,
        private readonly string $create,
        private readonly string $checkName
    ) {
        parent::__construct('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    }

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        [$rows, $width] = $this->answer($query);
        $params = [];
        $selects = [];
        foreach ($rows as $row) {
            $selects[] = 'SELECT ' . implode(', ', array_fill(0, count($row), '?'));
            array_push($params, ...$row);
        }
        $sql = $selects === []
            ? 'SELECT ' . implode(', ', array_fill(0, $width, 'NULL')) . ' WHERE 0'
            : implode(' UNION ALL ', $selects);
        $statement = parent::prepare($sql);
        $statement->execute($params);
        $statement->setFetchMode(PDO::FETCH_NUM);
        return $statement;
    }

    /** The rows of one catalog query and the number of its columns. */
    private function answer(string $query): array
    {
        $table = $this->catalog['table'];
        if (str_contains($query, 'information_schema.TABLES')) {
            return [[[$table, 'BASE TABLE', '']], 3];
        }
        if (str_contains($query, 'information_schema.COLUMNS')) {
            $rows = [];
            foreach ($this->catalog['columns'] as $column) {
                $rows[] = [
                    $table,
                    $column['name'],
                    $column['type'],
                    $column['nullable'],
                    null,
                    '',
                    $column['charset'],
                    $column['collation'],
                    ''
                ];
            }
            return [$rows, 9];
        }
        if (str_contains($query, 'information_schema.STATISTICS')) {
            return [[[$table, 'PRIMARY', 0, $this->catalog['primary_key'], 'A', 0, 0, 'BTREE']], 8];
        }
        if (str_contains($query, 'REFERENTIAL_CONSTRAINTS')) {
            return [[], 8];
        }
        if (str_contains($query, 'CHECK_CONSTRAINTS')) {
            return [[[$this->checkName, $this->catalog['stored_clause']]], 2];
        }
        if (str_contains($query, 'TABLE_CONSTRAINTS')) {
            return [[[$table, $this->checkName, 'YES']], 3];
        }
        if (str_contains($query, 'information_schema.TRIGGERS')) {
            return [[], 5];
        }
        if (str_contains($query, 'information_schema.ROUTINES') || str_contains($query, 'information_schema.EVENTS')) {
            return [[], 1];
        }
        if (str_contains($query, 'SHOW CREATE TABLE')) {
            return [[[$table, $this->create]], 2];
        }
        throw new RuntimeException("CannedCatalogPdo has no answer for the query $query");
    }
}

#[Small]
final class DbspecShowCreateIntrospectTest extends TestCase
{
    private static function data(): array
    {
        return json_decode(
            (string) file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/show-create.json'),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
    }

    public static function showCreateCases(): iterable
    {
        foreach (self::data()['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    // Requirements: DIA-84.
    #[DataProvider('showCreateCases')]
    public function test_introspect(array $case): void
    {
        $catalog = self::data()['catalog'];
        $table = $catalog['table'];
        $create = implode("\n", $case['create']) . "\n";
        $pdo = new CannedCatalogPdo($catalog, $create, $case['name']);
        if (isset($case['error'])) {
            $this->expectException(RuntimeException::class);
            $this->expectExceptionMessageMatches('/^' . preg_quote($case['error'], '/') . '$/');
            Dbspec::introspect($pdo, 'mysql', $table);
            return;
        }
        $result = Dbspec::introspect($pdo, 'mysql', $table);
        $checks = [];
        foreach (explode("\n", Dbspec::emit($result->document)) as $line) {
            $line = trim($line);
            if (str_starts_with($line, 'check ')) {
                $checks[] = $line;
            }
        }
        // The reason text differs between the clients, as the reasons of tests/dbspec/introspect.json are not compared;
        // the rule before the first ": " is compared.
        $reasons = array_map(
            static fn (Unsupported $u): string => "$u->kind $u->name: " . explode(': ', $u->reason, 2)[0],
            $result->unsupported,
        );
        $this->assertSame($case['checks'], $checks, 'checks');
        $this->assertSame($case['unsupported'], $reasons, 'unsupported');
    }
}
