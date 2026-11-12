<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

final class CollectionFakePdo extends \Polyspec\Orm\Tests\TransactionTrackingPdo
{
    public bool $suspendFirstStart = false;

    protected function afterStatement(string $statement): void
    {
        parent::afterStatement($statement);
        if (str_starts_with($statement, 'START TRANSACTION') && $this->suspendFirstStart) {
            $this->suspendFirstStart = false;
            \Fiber::suspend();
        }
    }
}
