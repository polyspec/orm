<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use Polyspec\Orm\Catalog;
use Polyspec\Orm\CatalogGridCell;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class CatalogQueryBoundsTest extends TestCase
{
    private string $path = '';
    private ?Catalog $catalog = null;

    protected function setUp(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'catalog-bounds-');
        self::assertIsString($path, 'tempnam could not create a file in the system temporary directory');
        $this->path = $path;
        $pdo = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('CREATE TABLE values_table (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
        $pdo->exec("INSERT INTO values_table (id, value) VALUES (1, 'alpha'), (2, 'beta')");
        $pdo = null;
        $this->catalog = Catalog::connect('sqlite://' . $path);
    }

    protected function tearDown(): void
    {
        $this->catalog?->close();
        if ($this->path !== '') {
            unlink($this->path);
        }
    }

    public function testPlainAndGridConsumersShareTheRowLimit(): void
    {
        $sql = 'SELECT value FROM values_table ORDER BY id';
        $this->assertLimit(fn () => $this->catalog->readOnlyQuery($sql, [], 1, 128), 'result has more than 1 rows');
        $this->assertLimit(
            fn () => $this->catalog->readOnlyGridQuery($sql, [], 1, 128),
            'result has more than 1 rows'
        );
    }

    public function testPlainAndGridConsumersShareTheByteLimit(): void
    {
        $sql = "SELECT 'abc' AS value";
        $this->assertLimit(fn () => $this->catalog->readOnlyQuery($sql, [], 2, 2), 'result has more than 2 bytes');
        $this->assertLimit(
            fn () => $this->catalog->readOnlyGridQuery($sql, [], 2, 2),
            'result has more than 2 bytes'
        );
    }

    public function testPlainAndGridConsumersPreserveSuccessfulRows(): void
    {
        $sql = 'SELECT value FROM values_table ORDER BY id';
        $plain = $this->catalog->readOnlyQuery($sql, [], 2, 128);
        self::assertSame([['alpha'], ['beta']], $plain->rows);
        $grid = $this->catalog->readOnlyGridQuery($sql, [], 2, 128);
        self::assertSame(
            [[['text', 'alpha']], [['text', 'beta']]],
            array_map(
                static fn (array $row): array => array_map(
                    static fn (CatalogGridCell $cell): array => [$cell->kind, $cell->value],
                    $row
                ),
                $grid->rows
            )
        );
    }

    public function testRowMutationsCheckTheLockedOriginalSnapshot(): void
    {
        $table = ['namespace' => $this->catalog->currentNamespace(), 'name' => 'values_table'];
        $page = $this->catalog->tablePage($table, 10, 0);
        $original = $this->catalog->rowSnapshotFromPage($page, 0);
        $updated = $this->catalog->updateRow($original, ['value' => 'alpha-updated']);
        self::assertSame([[1, 'alpha-updated']], $updated->rows);

        try {
            $this->catalog->deleteRow($original);
            self::fail('a stale row snapshot was accepted for deletion');
        } catch (OrmException $error) {
            self::assertSame(Code::ROW_CONFLICT, $error->code_);
        }

        $page = $this->catalog->tablePage($table, 10, 0);
        $current = $this->catalog->rowSnapshotFromPage($page, 0);
        self::assertSame(1, $this->catalog->deleteRow($current));
        self::assertSame([['beta']], $this->catalog->readOnlyQuery('SELECT value FROM values_table ORDER BY id')->rows);
    }

    private function assertLimit(\Closure $query, string $message): void
    {
        try {
            $query();
            self::fail('the bounded catalog query accepted an over-limit result');
        } catch (OrmException $error) {
            self::assertSame(Code::CATALOG_LIMIT, $error->code_);
            self::assertStringContainsString($message, $error->getMessage());
        }
    }
}
