<?php

// catalog_connection coverage (Requirements: SCH-5, SCH-6a): runs the two shared cases against the bench database that the
// feature check selected (ORM_FEATURE_DATABASE, ORM_FEATURE_DSN) through Catalog::connect. The read case only reads; the
// mutation case inserts, updates and deletes one row of composite_account in tenant 990005 and ends in the state it started in.
declare(strict_types=1);

use Polyspec\Orm\Catalog;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class CoverageCatalogConnectionTest extends TestCase
{
    private const TENANT = 990005;

    private string $driver = '';
    private ?Catalog $catalog = null;

    protected function setUp(): void
    {
        $this->driver = (string) getenv('ORM_FEATURE_DATABASE');
        self::assertContains($this->driver, ['mysql', 'postgres', 'sqlite'], 'ORM_FEATURE_DATABASE is required; run it through make feature-check');
        $this->catalog = Catalog::connect((string) getenv('ORM_FEATURE_DSN'));
        self::assertSame($this->driver, $this->catalog->dialect(), 'ORM_FEATURE_DSN selects another database');
    }

    protected function tearDown(): void
    {
        $this->catalog?->close();
    }

    private function quote(string $name): string
    {
        return $this->driver === 'mysql' ? "`{$name}`" : "\"{$name}\"";
    }

    public function test_read(): void
    {
        $namespace = $this->catalog->currentNamespace();
        $author = ['namespace' => $namespace, 'name' => 'author'];
        $meta = $this->catalog->describeTable($author);
        self::assertSame(['seq'], $meta->primaryKey);
        self::assertTrue($meta->reliableRowIdentity);
        $page = $this->catalog->tablePage($author, 3, 0);
        self::assertSame(['seq'], $page->orderBy);
        self::assertTrue($page->hasMore);
        self::assertCount(3, $page->result->rows);
        $count = $this->catalog->readOnlyQuery('SELECT COUNT(*) FROM ' . $this->quote('user'), []);
        self::assertSame(5000, (int) $count->rows[0][0]);
        $this->expectExceptionMessage('QUERY_READ_ONLY');
        $this->catalog->readOnlyQuery('UPDATE ' . $this->quote('user') . ' SET name = name WHERE seq = 1', []);
    }

    public function test_row_mutation(): void
    {
        $account = $this->quote('composite_account');
        $countSql = "SELECT COUNT(*) FROM {$account} WHERE tenant_id = " . self::TENANT;
        $tenantRows = fn (): int => (int) $this->catalog->readOnlyQuery($countSql, [])->rows[0][0];
        self::assertSame(0, $tenantRows());
        $table = ['namespace' => $this->catalog->currentNamespace(), 'name' => 'composite_account'];
        $meta = $this->catalog->describeTable($table);
        $inserted = $this->catalog->insertRow($meta, ['tenant_id' => self::TENANT, 'account_id' => 1, 'name' => 'catalog']);
        self::assertCount(1, $inserted->rows);
        $find = function (string $want) use ($table): object {
            $page = $this->catalog->tablePage($table, 1000, 0);
            self::assertFalse($page->hasMore);
            $found = [];
            foreach ($page->result->rows as $i => $row) {
                if ($row[$page->columnIndex('tenant_id')] === self::TENANT) {
                    $found[] = $i;
                }
            }
            self::assertCount(1, $found);
            self::assertSame($want, $page->result->rows[$found[0]][$page->columnIndex('name')]);
            return $this->catalog->rowSnapshotFromPage($page, $found[0]);
        };
        $updated = $this->catalog->updateRow($find('catalog'), ['name' => 'catalog-updated']);
        self::assertCount(1, $updated->rows);
        self::assertSame(1, $this->catalog->deleteRow($find('catalog-updated')));
        self::assertSame(0, $tenantRows());
    }
}
