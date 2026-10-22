<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * One checked original row: its descriptor, its cells, the positions of its primary-key cells and a SHA-256 revision of the
 * descriptor and the cells. It is not a write authorization; a change re-reads the row by its keys inside its own
 * transaction and compares it with the snapshot. Catalog::rowSnapshotFromPage creates it.
 *
 * @internal
 */
final class CatalogRowSnapshot
{
    /**
     * @param list<mixed> $cells
     * @param list<int> $keyIndexes
     */
    public function __construct(
        public readonly CatalogTableMetadata $metadata,
        public readonly array $cells,
        public readonly array $keyIndexes,
        public readonly string $revision,
    ) {
    }

    /** The SHA-256 revision of the descriptor and the cells, in lowercase hexadecimal. */
    public function revision(): string
    {
        return $this->revision;
    }
}
