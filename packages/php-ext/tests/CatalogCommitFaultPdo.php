<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use PDOException;

/**
 * An in-memory SQLite PDO whose next COMMIT throws $commitFailure when $failCommit is set, and whose next ROLLBACK
 * throws $rollbackFailure when $failRollback is set; every other statement runs normally.
 */
final class CatalogCommitFaultPdo extends PDO
{
    public bool $failCommit = false;
    public bool $failRollback = false;
    public PDOException $commitFailure;
    public PDOException $rollbackFailure;

    public function __construct()
    {
        parent::__construct('sqlite::memory:');
        $this->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->commitFailure = new PDOException('commit lost after the insert');
        $this->rollbackFailure = new PDOException('rollback lost after the insert');
    }

    public function exec(string $statement): int|false
    {
        if ($this->failCommit && $statement === 'COMMIT') {
            $this->failCommit = false;
            throw $this->commitFailure;
        }
        if ($this->failRollback && $statement === 'ROLLBACK') {
            $this->failRollback = false;
            throw $this->rollbackFailure;
        }
        return parent::exec($statement);
    }
}
