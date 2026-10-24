<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** @internal Marks a successfully introspected schema that differs from the requested plan. */
final class PlanSchemaMismatch extends \RuntimeException
{
}
