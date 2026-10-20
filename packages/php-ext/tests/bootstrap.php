<?php

declare(strict_types=1);

// The PHPUnit bootstrap of packages/php-ext (phpunit.xml.dist): the Composer autoloader of the development root (vendor-php),
// which loads PHPUnit and the PHP client polyspec/orm (packages/php), the specification that the extension's results are compared with. The
// extension polyspec_orm is loaded by the php that runs PHPUnit (php -d extension=<library>); without it no test can run.
require_once dirname(__DIR__, 3) . '/vendor-php/autoload.php';
if (!extension_loaded('polyspec_orm')) {
    throw new RuntimeException('the extension polyspec_orm is not loaded; run make dbspec-php-extension-check, which builds and loads it');
}

// requiredDsn is declared once, in the shared helper of the PHP client's testing directory.
require_once dirname(__DIR__, 2) . '/php/testing/required_dsn.php';
