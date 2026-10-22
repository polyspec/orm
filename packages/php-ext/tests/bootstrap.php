<?php

declare(strict_types=1);

// The PHPUnit bootstrap of packages/php-ext (phpunit.xml.dist), whose tests are the extension's own checks
// (DeclarationsTest): PHPUnit has loaded the Composer autoloader of the development root (vendor-php). The extension
// polyspec_orm is loaded by the php that runs PHPUnit (php -d extension=<library>); without it no test can run. Every
// behaviour it shares with the PHP client is checked by the client's tests (packages/php/tests), run with the extension
// loaded.
if (getenv('ORM_PHP_MODE') !== 'extension') {
    throw new RuntimeException(
        'the extension polyspec_orm is not loaded; run make dbspec-php-extension-check, which builds and loads it'
    );
}
// The functions that DeclarationsTest.php shares with declarations.php, which it runs as a child process.
require_once __DIR__ . '/declarations_functions.php';
