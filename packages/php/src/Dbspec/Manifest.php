<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * The manifest and schema texts of a document set and their hashes (docs/spec/dbspec.md, "Manifest and hashes").
 * externalText is the canonical text holding, for each external document, the tables that the owned documents use with their columns, primary key, unique keys,
 * and the foreign keys between used tables with the indexes that lead them,
 * and it is empty text if there are no external documents.
 */
final readonly class Manifest
{
    public function __construct(
        public string $manifestText,
        public string $schemaText,
        public string $manifestHash,
        public string $schemaHash,
        public string $externalText = '',
    ) {
    }
}
