<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * A catalog check expression that does not read as a dbspec predicate; introspection reports it as unsupported.
 *
 * @internal
 */
final class CheckDecodeFailure extends \Exception
{
}
