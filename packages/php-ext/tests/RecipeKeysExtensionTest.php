<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Tests\RecipeKeysTest;

// The refusal unit test of the recipe key check through the PHP extension (FCV-2 to FCV-4, T334-3-5-6): the extension runs the
// PHP loader's key check of the same test class.
#[Small]
final class RecipeKeysExtensionTest extends RecipeKeysTest
{
}
