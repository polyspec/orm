<?php
// The unit test of the PHP test autoloaders: bootstrap.php, the package's Composer autoloader that the PHPUnit tests run
// on, and autoload.php, the autoloader of the repository root that the programs outside the tests (conformance runners,
// examples) require. Every PHP test uses an autoloader, so a change to one is checked by this test, not by the
// verification of every feature (the helpers of contracts/features.json). make orm-check runs the full verification.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/AutoloadTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;

// autoload.php runs in a child process: loading it beside bootstrap.php would load the generated models twice.
#[Large]
final class AutoloadTest extends TestCase
{
    // A class of its own file, a class defined in another file (Frame is in Model.php) and a class of a sub-namespace.
    private const CLASSES = ['Polyspec\\Orm\\Model', 'Polyspec\\Orm\\Frame', 'Polyspec\\Orm\\OrmException', 'Polyspec\\Orm\\Dbspec\\Dbspec'];

    public function test_bootstrap(): void
    {
        foreach (self::CLASSES as $class) {
            self::assertTrue(class_exists($class), "$class is not found");
        }
        // An absent class is not found.
        self::assertFalse(class_exists('Polyspec\\Orm\\NoSuchClass'), 'Polyspec\\Orm\\NoSuchClass is found');
    }

    public function test_autoload(): void
    {
        $code = 'require $argv[1]; foreach (array_slice($argv, 2) as $class) { echo $class, " ", class_exists($class) ? "found" : "missing", "\n"; }';
        $process = proc_open([PHP_BINARY, '-r', $code, __DIR__ . '/autoload.php', ...self::CLASSES, 'Polyspec\\Orm\\NoSuchClass'], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        self::assertIsResource($process);
        $out = (string) stream_get_contents($pipes[1]);
        $err = (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        self::assertSame(0, proc_close($process), $err);
        $want = implode('', array_map(static fn(string $class): string => "$class found\n", self::CLASSES)) . "Polyspec\\Orm\\NoSuchClass missing\n";
        self::assertSame($want, $out);
    }
}
