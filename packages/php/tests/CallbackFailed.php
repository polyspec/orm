<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use RuntimeException;

/** The error of a failing transaction callback. The step's error "callback" expects this error. */
final class CallbackFailed extends RuntimeException
{
}
