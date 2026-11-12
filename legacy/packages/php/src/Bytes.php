<?php

declare(strict_types=1);

namespace Polyspec\Orm;

use Polyspec\OrderedJson\Value;

use function Polyspec\OrderedJson\parse as orderedJsonParse;
use function Polyspec\OrderedJson\stringify as orderedJsonStringify;

/** A binary value: one to bind as a blob (bytea/BLOB), such as the raw AES output or a packed address a host stage produced, and the value of a bytes column in the array form (COD-27). */
final class Bytes
{
    public function __construct(public readonly string $bytes)
    {
    }
}
