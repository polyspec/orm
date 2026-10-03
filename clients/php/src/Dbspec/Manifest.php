<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/** The manifest and schema texts of a document set and their hashes (docs/dbspec.md, "Manifest and hashes"). */
final readonly class Manifest
{
    public function __construct(
        public string $manifestText,
        public string $schemaText,
        public string $manifestHash,
        public string $schemaHash,
    ) {
    }
}
