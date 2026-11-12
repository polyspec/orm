<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** The abstract static metadata contract implemented by generated models: the meta() array of DBS-120. */
interface ModelMetadata
{
    public static function meta(): array;
}
