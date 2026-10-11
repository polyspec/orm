<?php
declare(strict_types=1);
// Polyspec\Orm\Dbspec\Native\Dbspec::introspect of the PHP extension orm_dbspec on MySQL, reading a canned catalog
// (T62-4-8). The double CannedCatalogPdo answers each catalog query of mysql_read with the rows of
// tests/dbspec/show-create.json ("catalog" and each case), so the reader of shown_check goes to SHOW CREATE TABLE
// for the body of the one CHECK. Each case expects the same checks and unsupported objects as the Go introspection
// of the same answers (engine/dbspec show_create_introspect_test.go reads the same file), or the error of a CHECK
// the statement lacks.
// Usage: php -d extension=<orm_dbspec library> packages/orm-php-extension/tests/dbspec_show_create_test.php
require dirname(__DIR__, 3) . '/tests/testcase.php';

if (!extension_loaded('orm_dbspec')) {
    fwrite(STDERR, "the extension orm_dbspec is not loaded; run make dbspec-php-extension-check, which builds and loads it\n");
    exit(1);
}

use Polyspec\Orm\Dbspec\Native\Dbspec;
use Polyspec\Orm\Dbspec\Native\Unsupported;

/**
 * A PDO whose query() answers the catalog queries of MySQL introspection from the canned catalog. The rows are
 * returned by a statement of an in-memory SQLite database, so the extension reads them through the PDOStatement
 * API as it reads a MySQL connection.
 */
final class CannedCatalogPdo extends PDO
{
    /** @param array<string, mixed> $catalog */
    public function __construct(private readonly array $catalog, private readonly string $create, private readonly string $checkName)
    {
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
                $rows[] = [$table, $column['name'], $column['type'], $column['nullable'], null, '', $column['charset'], $column['collation'], ''];
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

$data = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/show-create.json'), true, 512, JSON_THROW_ON_ERROR);
$catalog = $data['catalog'];
$table = $catalog['table'];

$cases = new TestCases();
foreach ($data['cases'] as $case) {
    $cases->run('dbspec/show-create introspect ' . $case['id'], TESTCASE_COMPUTE, function (callable $step) use ($case, $catalog, $table): void {
        $create = implode("\n", $case['create']) . "\n";
        $pdo = new CannedCatalogPdo($catalog, $create, $case['name']);
        $step('introspect the canned catalog with the check ' . $case['name']);
        if (isset($case['error'])) {
            try {
                Dbspec::introspect($pdo, 'mysql', $table);
            } catch (RuntimeException $e) {
                if ($e->getMessage() !== $case['error']) {
                    throw new RuntimeException('introspect failed with ' . var_export($e->getMessage(), true) . ', want ' . var_export($case['error'], true));
                }
                return;
            }
            throw new RuntimeException('introspect did not fail, want ' . var_export($case['error'], true));
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
        if ($checks !== $case['checks']) {
            throw new RuntimeException('checks ' . json_encode($checks) . ', want ' . json_encode($case['checks']));
        }
        if ($reasons !== $case['unsupported']) {
            throw new RuntimeException('unsupported ' . json_encode($reasons) . ', want ' . json_encode($case['unsupported']));
        }
    });
}
$cases->finish();
