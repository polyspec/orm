<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use RuntimeException;

/** The error a callback throws to stop what calls it: a transaction, which rolls back, or a dbspec command. */
final class Stop extends RuntimeException
{
}
