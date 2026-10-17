<?php
declare(strict_types=1);
// The PHPUnit bootstrap of packages/php-ext (phpunit.xml.dist): the Composer autoloader of the development root (vendor-php),
// which loads PHPUnit and the PHP client polyspec/orm (packages/php), the specification that the extension's results are compared with. The
// extension orm_dbspec is loaded by the php that runs PHPUnit (php -d extension=<library>); without it no test can run.
require_once dirname(__DIR__, 3) . '/vendor-php/autoload.php';
if (!extension_loaded('orm_dbspec')) {
    throw new RuntimeException('the extension orm_dbspec is not loaded; run make dbspec-php-extension-check, which builds and loads it');
}

/** A DSN variable of the test servers' environment; unset fails with its name, and a database test never skips. */
function requiredDsn(string $name): string
{
    $value = getenv($name);
    if (!is_string($value) || $value === '') {
        throw new RuntimeException("$name is not set; run the test through make test-servers or its make target");
    }
    return $value;
}
