<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PDO;
use PDOStatement;

final class ConnectionTimeoutCleanupPdo extends PDO
{
    public int $prepareCalls = 0;
    public int $closeCursorCalls = 0;
    public int $executeCalls = 0;
    public array $failureInfo = ['57014', null, 'statement timeout'];

    public function __construct()
    {
        parent::__construct('sqlite::memory:');
    }

    public function setAttribute(int $attribute, mixed $value): bool
    {
        return true;
    }

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        $this->prepareCalls++;
        if (
            !parent::setAttribute(
                PDO::ATTR_STATEMENT_CLASS,
                [ConnectionTimeoutCleanupStatement::class, [$this, $query]],
            )
        ) {
            throw new \RuntimeException('unable to configure the timeout cleanup fake statement');
        }
        return parent::prepare('SELECT 1');
    }
}
