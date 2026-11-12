<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * The event metadata of one statement observed by a connection.
 *
 * @internal
 */
final readonly class StatementMetadata
{
    /**
     * @param list<string> $tables
     * @param list<mixed> $binds
     */
    public function __construct(
        public string $kind,
        public array $tables,
        public ?int $transaction,
        public string $sql,
        public array $binds,
    ) {
    }
}
