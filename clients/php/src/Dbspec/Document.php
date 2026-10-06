<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** A parsed dbspec document. Comments are kept with the line that follows them. */
final class Document
{
    /** @var list<UseLine> */
    public array $uses = [];
    /** @var list<Table> */
    public array $tables = [];
    /** @var list<Diagram> */
    public array $diagrams = [];
    /** @var list<string> Comment lines after the last line of the document. */
    public array $trailingComments = [];
    /**
     * 문서가 set의 소유가 아니라 소유한 문서가 use로 쓰는 외부 문서임을 뜻한다. 외부 문서는
     * parse하고 검사하지만 렌더링, 설치, 비교, 생성하지 않는다(docs/dbspec.md "Documents and
     * use"). 문서 text에는 나오지 않는다.
     */
    public bool $external = false;

    public function __construct(public string $name)
    {
    }
}
