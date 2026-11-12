<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * A setting line stops at its first syntax error. The diagnostic is already recorded, and the line is discarded.
 *
 * @internal
 */
final class SettingFailure extends \Exception
{
}
