<?php

// The package test of orm-gen: polyspec/orm holds its generator, so the autoload of packages/php/composer.json
// alone resolves Polyspec\Orm\Generator, and the bin/orm-gen that the package declares generates models (T244).
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenPackageTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

// The case reads the PSR-4 map of packages/php and runs its bin in a new process with the autoloader of the
// repository root, as the Composer proxy of a consumer does.
#[Small]
class OrmGenPackageTest extends TestCase
{
    public function testThePhpPackageAloneLoadsTheGeneratorAndRunsOrmGen(): void
    {
        $package = dirname(__DIR__);
        $manifest = json_decode((string) file_get_contents("$package/composer.json"), true, flags: JSON_THROW_ON_ERROR);
        $directory = $manifest['autoload']['psr-4']['Polyspec\\Orm\\'] ?? null;
        self::assertIsString($directory, 'polyspec/orm maps the namespace Polyspec\Orm');
        self::assertFileExists("$package/{$directory}Generator.php", 'its PSR-4 folder holds Polyspec\Orm\Generator');
        self::assertContains('bin/orm-gen', $manifest['bin'] ?? [], 'polyspec/orm declares bin/orm-gen');

        $work = OrmGenTestSupport::createWorkDirectory('orm-php-package-');
        try {
            $set = OrmGenTestSupport::setFile($work, ['typed.dbs']);
            file_put_contents("$work/typed.dbs", OrmGenTestSupport::FIELD_TYPES_DOCUMENT);
            $autoload = dirname(__DIR__, 3) . '/vendor-php/autoload.php';
            $run = '$_composer_autoload_path = ' . var_export($autoload, true) . '; '
                . 'require ' . var_export("$package/bin/orm-gen", true) . ';';
            $result = OrmGenTestSupport::runProcess([
                PHP_BINARY, '-r', $run, '--',
                'gen', '--set', $set, '--out', "$work/model", '--namespace', 'Package\\Model',
            ]);
            self::assertNotNull($result, 'cannot start the bin of packages/php');
            [$code, $stdout, $stderr] = $result;
            self::assertSame(0, $code, "$stdout $stderr");
            self::assertFileExists("$work/model/Item.php");
        } finally {
            OrmGenTestSupport::removeWorkDirectory($work);
        }
    }
}
