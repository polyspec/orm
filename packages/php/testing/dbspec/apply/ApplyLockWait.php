<?php

declare(strict_types=1);

namespace Polyspec\Orm\Testing;

use PDO;
use Polyspec\Orm\Dbspec\ApplyEvent;
use RuntimeException;

/** The lock and the apply event handler of the lock-wait cases of the apply runner and DbspecApplyTest. */
final class ApplyLockWait
{
    /**
     * A handler that appends [kind, step] of each statement and applied event of an apply to $steps.
     *
     * @param list<array{string, int}> $steps
     * @return \Closure(ApplyEvent): void
     */
    public static function recorder(array &$steps): \Closure
    {
        return static function (ApplyEvent $event) use (&$steps): void {
            if ($event->kind === 'statement' || $event->kind === 'applied') {
                $steps[] = [$event->kind, $event->step];
            }
        };
    }

    /**
     * Begins a transaction of $blocker that inserts a row of archive and locks the archive rows with SELECT FOR
     * UPDATE, so that an apply that changes archive waits for that lock.
     */
    public static function holdArchiveRows(PDO $blocker): void
    {
        $blocker->beginTransaction();
        $blocker->exec("INSERT INTO archive (note) VALUES ('lock wait')");
        $statement = $blocker->query('SELECT id FROM archive FOR UPDATE');
        if ($statement === false) {
            throw new RuntimeException('could not lock the representative archive row');
        }
        $statement->fetchAll(PDO::FETCH_NUM);
        $statement->closeCursor();
    }
}
