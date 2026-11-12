<?php

// The MySQL cancellation cases of QueryCancellationDbCases on MariaDB, a server of the MySQL dialect
// (docs/spec/dialects.md DIA-200), as QueryCancellationTest runs them on MySQL. The entry of MariaDB is a class of its
// own, so the targets of the MySQL servers do not run it and make mariadb-recipes-check/php runs it.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class QueryCancellationMariadbTest extends TestCase
{
    use QueryCancellationDbCases;

    // Requirements: CFG-9.
    public function testMariadbLockEventCancelsActiveStatementRollsBackAndReconnectsRoot(): void
    {
        self::lockEventCancelsActiveStatementRollsBackAndReconnectsRoot('mariadb');
    }

    // Requirements: CFG-9.
    public function testMariadbCancellationStopsEveryActiveRootAndReopensEachProcessRoot(): void
    {
        self::cancellationStopsEveryActiveRootAndReopensEachProcessRoot('mariadb');
    }
}
