<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The catalog row reader of the PHP library (Dbspec\CatalogRows), an internal class that the extension
// implements in C; the shared dbspec vectors stay in DbspecTest, which runs on the library and the extension.

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\CatalogRows;

#[Small]
final class DbspecCatalogRowsTest extends TestCase
{
    public function testCatalogTextSelectionPreservesOrderAndQueryDiagnostics(): void
    {
        $query = "SELECT first, value, last\nFROM catalog";
        self::assertSame(['first', 'last'], CatalogRows::texts(['first', 2, 'last'], [0, 2], $query));

        try {
            CatalogRows::texts(['first', 2, 'last'], [1], $query);
            self::fail('a non-text catalog value was accepted');
        } catch (\UnexpectedValueException $error) {
            self::assertSame(
                'Catalog value 1 is int, not a string, in SELECT first, value, last',
                $error->getMessage()
            );
        }
    }

    public function testCatalogNamedRowsPreserveRawValues(): void
    {
        $connection = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $rows = CatalogRows::namedRows($connection, "SELECT 'users', 'BASE TABLE', 'partitioned'");

        self::assertSame(
            [['users', 'BASE TABLE', ['users', 'BASE TABLE', 'partitioned']]],
            iterator_to_array($rows, false)
        );
    }
}
