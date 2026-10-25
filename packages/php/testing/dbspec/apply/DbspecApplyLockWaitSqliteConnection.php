<?php

declare(strict_types=1);

namespace Polyspec\Orm\Testing;

use PDO;
use PDOException;

/** Releases the SQLite blocker before Apply runs its cleanup after a failed exclusive BEGIN. */
final class DbspecApplyLockWaitSqliteConnection extends PDO
{
    public bool $blockerReleased = false;

    public function __construct(string $dsn, ?string $user, ?string $password, array $options, private PDO $blocker)
    {
        parent::__construct($dsn, $user, $password, $options);
    }

    public function exec(string $statement): int|false
    {
        try {
            return parent::exec($statement);
        } catch (PDOException $error) {
            if ($statement === 'BEGIN EXCLUSIVE' && $this->blocker->inTransaction()) {
                $this->blocker->exec('ROLLBACK');
                $this->blockerReleased = true;
            }
            throw $error;
        }
    }
}
