<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\CaseDeadlineTest;

// The unit test of the step deadline of a recipe case through the PHP extension (FCV-4): the extension runs the PHP
// recipe runner's CaseDeadline of the same test class.
#[Small]
final class CaseDeadlineExtensionTest extends CaseDeadlineTest
{
}
