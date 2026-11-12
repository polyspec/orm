<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

// The PHP library runs the catalog cases on a PDO that the extension runs in CatalogConnectionSurfaceTest.
#[Small]
final class CatalogPdoTest extends TestCase
{
    use CatalogPdoCases;
}
