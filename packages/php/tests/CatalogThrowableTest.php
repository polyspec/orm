<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

// The PHP library runs the cases of the PDO throwables that the extension runs in CatalogConnectionSurfaceTest.
#[Small]
final class CatalogThrowableTest extends TestCase
{
    use CatalogThrowableCases;
}
