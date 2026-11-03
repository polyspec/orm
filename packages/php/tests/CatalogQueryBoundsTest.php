<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use Polyspec\Orm\Catalog;
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
        $pdo->exec('CREATE TABLE generated_values (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)');
        $pdo->exec(
            'CREATE TABLE computed_values (id INTEGER PRIMARY KEY, value TEXT NOT NULL, '
            . 'value_length INTEGER GENERATED ALWAYS AS (length(value)) STORED)'
        );
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

    public function testGeneratedKeyInsertVerifiesItsReturnedRow(): void
    {
        $metadata = $this->catalog->describeTable([
            'namespace' => $this->catalog->currentNamespace(),
            'name' => 'generated_values',
        ]);
        $inserted = $this->catalog->insertRow($metadata, ['value' => 'gamma']);
        self::assertSame([[1, 'gamma']], $inserted->rows);

        $verify = new \ReflectionMethod(Catalog::class, 'verifyInsertedRow');
        foreach (
            [
                [Code::ROW_IDENTITY_AMBIGUOUS, 'expected exactly one inserted locator row'],
                [Code::ROW_WRITE_MISMATCH, 'expected one generated-key row'],
            ] as [$code, $message]
        ) {
            try {
                $verify->invoke(null, [], [], $code, $message, 'unused');
                self::fail('a missing generated-key row was accepted');
            } catch (OrmException $error) {
                self::assertSame($code, $error->code_);
                self::assertSame($code . ': ' . $message, $error->getMessage());
            }
        }
        try {
            $verify->invoke(
                null,
                [[1, 'actual']],
                [[1, 'requested']],
                Code::ROW_WRITE_MISMATCH,
                'unused',
                'inserted values differ'
            );
            self::fail('a returned generated-key row with changed values was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::ROW_WRITE_MISMATCH, $error->code_);
            self::assertSame('ROW_WRITE_MISMATCH: inserted values differ', $error->getMessage());
        }
    }

    public function testRowBaselineComparesExactValuesIncludingGeneratedOriginals(): void
    {
        $sameRow = new \ReflectionMethod(Catalog::class, 'sameRow');
        foreach (
            [
                [[0.0], [-0.0]],
                [['100.23000'], ['100.23']],
                [["\x00\xff"], ["\x00\xfe"]],
                [[false], [0]],
                [[1, 'generated-original'], [1, 'generated-current']],
            ] as [$original, $current]
        ) {
            self::assertFalse($sameRow->invoke(null, $current, $original));
        }

        $table = ['namespace' => $this->catalog->currentNamespace(), 'name' => 'computed_values'];
        $metadata = $this->catalog->describeTable($table);
        self::assertTrue($metadata->columns[2]->generated);
        $this->catalog->insertRow($metadata, ['id' => 1, 'value' => 'four']);
        $snapshot = $this->catalog->rowSnapshotFromPage($this->catalog->tablePage($table, 1, 0), 0);
        self::assertSame(4, $snapshot->cells[2]);
        $setup = new PDO('sqlite:' . $this->path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $setup->exec("UPDATE computed_values SET value = 'changed' WHERE id = 1");
        try {
            $this->catalog->updateRow($snapshot, ['value' => 'write']);
            self::fail('a changed generated-column value was accepted by the old baseline');
        } catch (OrmException $error) {
            self::assertSame(Code::ROW_CONFLICT, $error->code_);
        }
    }
}
