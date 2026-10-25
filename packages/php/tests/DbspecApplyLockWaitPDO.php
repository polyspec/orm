<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;

/** Releases the SQLite blocker as soon as BEGIN EXCLUSIVE reports its bounded wait. */
final class DbspecApplyLockWaitPDO extends PDO
{
    public ?PDO $blocker = null;
    public bool $blockerReleased = false;

    public function exec(string $statement): int|false
    {
        try {
            return parent::exec($statement);
        } catch (\PDOException $error) {
            if ($statement === 'BEGIN EXCLUSIVE' && $this->blocker?->inTransaction()) {
                $this->blocker->exec('ROLLBACK');
                $this->blockerReleased = true;
            }
            throw $error;
        }
    }
}
