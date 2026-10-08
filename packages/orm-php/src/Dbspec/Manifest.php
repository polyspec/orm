<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * The manifest and schema texts of a document set and their hashes (docs/dbspec.md, "Manifest and hashes").
 * externalText는 외부 문서마다 소유한 문서가 쓰는 table의 column, primary key, unique key만 담은
 * canonical text이며 외부 문서가 없으면 빈 text다.
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
