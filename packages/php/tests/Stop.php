<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use RuntimeException;

/** The error the callback throws to roll back the transaction. */
final class Stop extends RuntimeException
{
}
