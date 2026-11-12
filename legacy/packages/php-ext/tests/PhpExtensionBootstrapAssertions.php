<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

final class PhpExtensionBootstrapAssertions extends \PHPUnit\Framework\Assert
{
    public static function requireLoaded(): void
    {
        self::assertTrue(
            extension_loaded('polyspec_orm'),
            'the extension polyspec_orm is not loaded; run make dbspec-php-extension-check, which builds and loads it'
        );
    }
}
