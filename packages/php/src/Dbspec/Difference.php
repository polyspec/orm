<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * 두 schema 의 차이 하나다(docs/plans.md "Comparison"). name 은 column 이나
 * 객체의 이름이고, table 단위 차이에서는 빈 문자열이다.
 */
final readonly class Difference
{
    public function __construct(public string $kind, public string $table, public string $name)
    {
    }
}
