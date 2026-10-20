<?php

declare(strict_types=1);

// The PHPUnit bootstrap of packages/php-ext (phpunit.xml.dist), whose tests are the extension's own checks (DeclarationsTest):
// PHPUnit has loaded the Composer autoloader of the development root (vendor-php). The extension polyspec_orm is loaded by the php
// that runs PHPUnit (php -d extension=<library>); without it no test can run. Every behaviour it shares with the PHP client is
// checked by the client's tests (packages/php/tests), run with the extension loaded.
if (!extension_loaded('polyspec_orm')) {
    throw new RuntimeException('the extension polyspec_orm is not loaded; run make dbspec-php-extension-check, which builds and loads it');
}
