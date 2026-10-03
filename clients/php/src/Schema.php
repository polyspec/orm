<?php
declare(strict_types=1);

namespace Orm;

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
     * text가 선언한 hash로 hash되는지 확인한다. 다르면 어떤 statement보다 먼저
     * CONFIG다. manifestHash는 manifest text 뒤에 external text를 이은 text의 sha256이다.
     */
    public function verify(): void
    {
        $actual = 'sha256:' . hash('sha256', $this->manifestText . $this->externalText);
        if ($actual !== $this->manifestHash) {
            throw new OrmException(Code::CONFIG, "invalid schema manifest: the manifest text hashes to $actual, not to its declared manifestHash {$this->manifestHash}");
        }
    }

    /**
     * set의 parse한 문서다. 외부 문서는 external로 표시되며 소유한 문서가 쓰는 table만 갖는다.
     *
     * @return list<Dbspec\Document>
     */
    public function documents(): array
    {
        return RuntimeModel::loadSet($this->manifestText, $this->externalText);
    }
}
