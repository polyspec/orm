<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal 한 markdown 답 행의 join과 relation 행이다. 행의 마지막 칸에 둔다. */
final class MarkdownLinks
{
    /** @var array<string, list<mixed>|null> join 이름 => 그 위치 행, 없으면 null */
    public array $joins = [];
    /** @var array<string, list<list<mixed>>> relation 이름 => 그 위치 행들 */
    public array $rels = [];
}
