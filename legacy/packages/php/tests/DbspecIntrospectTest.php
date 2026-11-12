<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// Native under FCV-2: the error mode of a PDO connection exists only in this runtime. The failing query of an
// exception-mode connection is the recipe case catalog_query_failure.
// Requirements: DIA-133a.

use PDO;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;
use RuntimeException;

#[Small]
class DbspecIntrospectTest extends TestCase
{
    // Requirements: DIA-133a.
    public function testQueryFailureInSilentErrorMode(): void
    {
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('information_schema');
        Dbspec::introspect(
            new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_SILENT]),
            'mysql',
            'mysql',
            'introspected'
        );
    }
}
