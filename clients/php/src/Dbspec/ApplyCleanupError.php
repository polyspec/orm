<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * A failure of apply or recover after which cleanup failed too (docs/plans.md
 * "Apply"): the previous throwable is the first failure, unchanged (an
 * ApplyError, a database error or the exception of an event handler), and
 * `cleanup` lists in order the errors of releasing the lock, ending the
 * transaction, restoring SQLite foreign keys or closing a result that
 * followed it.
 */
final class ApplyCleanupError extends \RuntimeException
{
    /** @param list<\Throwable> $cleanup */
    public function __construct(\Throwable $failure, public readonly array $cleanup)
    {
        if ($cleanup === []) {
            throw new \InvalidArgumentException('ApplyCleanupError needs at least one cleanup error');
        }
        $message = $failure->getMessage();
        foreach ($cleanup as $e) {
            $message .= '; cleanup: ' . $e->getMessage();
        }
        parent::__construct($message, 0, $failure);
    }
}
