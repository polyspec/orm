<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\DbspecTest;

// The strict reader of tests/dbspec/cases.json through the extension: a harness test, not a client behaviour.
#[\PHPUnit\Framework\Attributes\Small]
final class DbspecTestExtensionTest extends DbspecTest
{
}
