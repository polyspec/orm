<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

class TransactionTrackingPdo extends UninitializedRecordingPdo
{
    private bool $transaction = false;

    protected function afterStatement(string $statement): void
    {
        parent::afterStatement($statement);
        if ($statement === 'BEGIN IMMEDIATE' || str_starts_with($statement, 'START TRANSACTION')) {
            $this->transaction = true;
        } elseif ($statement === 'COMMIT' || $statement === 'ROLLBACK') {
            $this->transaction = false;
        }
    }

    public function inTransaction(): bool
    {
        return $this->transaction;
    }
}
