<?php

declare(strict_types=1);

namespace Polyspec\Orm;

use Polyspec\OrderedJson\Value;
use Symfony\Component\Yaml\Yaml;

use function Polyspec\OrderedJson\parse as orderedJsonParse;
use function Polyspec\OrderedJson\stringify as orderedJsonStringify;

/** A binary value to bind as a blob (bytea/BLOB): the raw AES output or a packed address a host stage produced. */
final class Bytes
{
    public function __construct(public readonly string $bytes)
    {
    }
}
