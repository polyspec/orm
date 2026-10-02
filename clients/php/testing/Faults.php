<?php
declare(strict_types=1);

namespace Orm\Testing;

use Orm\Db;

/**
 * The test entry point of the PHP client. The package autoloader does not map
 * this file, so a process has this class only after it requires
 * `testing/Faults.php` of the package by its path.
 */
final class Faults
{
    /**
     * Arms a test fault on the connection: the next rollback of a transaction
     * whose callback failed runs, and then reports a FAULT error as its
     * rollback error, so the transaction throws a ROLLBACK error that keeps
     * the callback error and the fault. The fault stays armed until such a
     * rollback consumes it.
     */
    public static function failNextRollback(Db $db): void
    {
        (\Closure::bind(static function (Db $db): void {
            $db->rollbackFault = true;
        }, null, Db::class))($db);
    }
}
