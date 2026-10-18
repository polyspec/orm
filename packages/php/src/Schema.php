<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * The generated schema value: the manifest text of a document set with its
 * declared manifestHash and, for a set that uses external documents, the
 * external text (the tables the set uses from them). Orm::connectSchema and
 * SchemaUtils::install take it to register the set on a connection.
 */
final class Schema
{
    public function __construct(
        public readonly string $manifestText,
        public readonly string $manifestHash,
        public readonly string $externalText = '',
    ) {}

    /**
     * Checks that the text hashes to the declared hash. If not, it is CONFIG, before any statement.
     * manifestHash is the sha256 of the manifest text followed by the external text.
     */
    public function verify(): void
    {
        $actual = 'sha256:' . hash('sha256', $this->manifestText . $this->externalText);
        if ($actual !== $this->manifestHash) {
            throw new OrmException(Code::CONFIG, "invalid schema manifest: the manifest text hashes to $actual, not to its declared manifestHash {$this->manifestHash}");
        }
    }

    /**
     * The parsed documents of the set. External documents are marked external and carry only the tables the owned documents use.
     *
     * @return list<Dbspec\Document>
     */
    public function documents(): array
    {
        return RuntimeModel::loadSet($this->manifestText, $this->externalText);
    }
}
