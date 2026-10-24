<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Db;
use RuntimeException;

trait TransactionCloseDuringFailure
{
    private function closeDuringTransaction(Db $db, RuntimeException $failure): ?RuntimeException
    {
        $caught = null;
        try {
            $db->transaction(static function () use ($db, $failure): void {
                $db->close();
                throw $failure;
            }, retry: 0);
        } catch (RuntimeException $error) {
            $caught = $error;
        }
        return $caught;
    }
}
