<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Closure;
use PDO;
use PDOException;
use PDOStatement;

// A real server does not refuse the cleanup statement and the rollback at the end of a transaction, so
// PDO rejects the chosen statement, and with rejectRollback it makes the rollback fail.
// The rollback is actually finished first, and then the failure is returned.
final class ModelTestFailingPdo extends PDO
{
    /** @var ?Closure(string): bool */
    public ?Closure $rejects = null;
    public bool $rejectRollback = false;

    private function check(string $statement): void
    {
        if ($this->rejects !== null && ($this->rejects)($statement)) {
            throw new PDOException('statement rejected by the test driver');
        }
    }

    public function exec(string $statement): int|false
    {
        $this->check($statement);
        $result = parent::exec($statement);
        // rejectRollback runs the client's ROLLBACK and then reports it as a failure.
        if ($statement === 'ROLLBACK' && $this->rejectRollback) {
            throw new PDOException('rollback rejected by the test driver');
        }
        return $result;
    }

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        $this->check($query);
        return parent::prepare($query, $options);
    }
}
