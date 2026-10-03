<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/** Stops a check expression at its first structural error. */
final class ExpressionFailure extends \Exception
{
}
