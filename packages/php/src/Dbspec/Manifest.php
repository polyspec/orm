<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * The manifest and schema texts of a document set and their hashes (docs/dbspec.md, "Manifest and hashes").
 * externalText is the canonical text holding, for each external document, only the columns, primary key, and unique keys of the tables that the owned document uses,
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
