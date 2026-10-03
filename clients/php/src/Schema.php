<?php
declare(strict_types=1);

namespace Orm;

/**
 * The generated schema value: the manifest text of a document set with its
 * declared manifestHash. Orm::connectSchema and SchemaUtils::install take it
 * to register the set on a connection.
 */
final class Schema
{
    public function __construct(
        public readonly string $manifestText,
        public readonly string $manifestHash,
    ) {}

    /**
     * text가 선언한 hash로 hash되는지 확인한다. 다르면 어떤 statement보다 먼저
     * CONFIG다. manifestHash는 manifest text의 sha256이다.
     */
    public function verify(): void
    {
        $actual = 'sha256:' . hash('sha256', $this->manifestText);
        if ($actual !== $this->manifestHash) {
            throw new OrmException(Code::CONFIG, "invalid schema manifest: the manifest text hashes to $actual, not to its declared manifestHash {$this->manifestHash}");
        }
    }
}
