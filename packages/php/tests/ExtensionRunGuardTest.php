<?php

declare(strict_types=1);

// The extension run guard (extension_run_guard.php, T182-6-19): a run that loads a file of the PHP library holding a
// class the extension declares fails at its end and names the file; a run that loads none, or loads only library
// files the extension does not provide, such as the generator (T302), passes. Each case runs a php -n child that
// registers the guard.

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class ExtensionRunGuardTest extends TestCase
{
    // Requirements: PRT-18.
    public function testRunThatLoadsALibraryFileFails(): void
    {
        $source = self::source();
        [$status, $errors] = self::child($source, "$source/AesRotationStatus.php");
        self::assertSame(1, $status, 'a run that loaded a library file exits 1');
        self::assertStringContainsString("$source/AesRotationStatus.php", $errors, 'the guard names the file');
    }

    // Requirements: PRT-18.
    public function testRunThatLoadsNoLibraryFilePasses(): void
    {
        [$status, $errors] = self::child(self::source(), null);
        self::assertSame(0, $status, "a run that loaded no library file exits 0: $errors");
        self::assertSame('', $errors);
    }

    // Requirements: PRT-18.
    public function testRunThatLoadsOnlyLibraryToolingPasses(): void
    {
        $source = self::source();
        [$status, $errors] = self::child($source, "$source/OrmGen.php");
        self::assertSame(0, $status, "a run that loaded only the generator, absent in the extension, passes: $errors");
        self::assertSame('', $errors);
    }

    // Requirements: PRT-18.
    public function testOnlyDeclaredClassesOfTheFolderCount(): void
    {
        $classes = ['Polyspec\\Orm\\Db' => true, 'Polyspec\\Orm\\Dbspec\\Table' => true];
        self::assertSame(
            ['/r/packages/php/src/Db.php', '/r/packages/php/src/Dbspec/Table.php'],
            librarySourcesLoaded(
                [
                    '/r/packages/php/src/Db.php',
                    '/r/packages/php/src/Dbspec/Table.php',
                    '/r/packages/php/src/OrmGen.php',
                    '/r/packages/php/srcx/Db.php',
                    '/r/vendor/a.php',
                ],
                '/r/packages/php/src',
                $classes
            )
        );
        self::assertSame([], librarySourcesLoaded(['/r/packages/php/tests/Db.php'], '/r/packages/php/src/', $classes));
    }

    // Requirements: PRT-18.
    public function testDeclaredClassesAreTheClassKeysOfTheRecord(): void
    {
        self::assertSame(
            ['Polyspec\\Orm\\Db' => true],
            extensionClasses([
                'packages/php-ext/src/polyspec_orm.stub.php::Polyspec\\Orm\\Db' => [],
                'packages/php-ext/src/polyspec_orm.stub.php::Polyspec\\Orm\\Db::connect' => [],
            ])
        );
    }

    private static function source(): string
    {
        $source = realpath(dirname(__DIR__) . '/src');
        self::assertIsString($source, 'packages/php/src exists');
        return $source;
    }

    /** @return array{int, string} the exit status and the stderr of a child that guards $source and loads $load */
    private static function child(string $source, ?string $load): array
    {
        $symbols = dirname(__DIR__, 3) . '/contracts/symbols/php-extension.json';
        $code = 'require ' . var_export(__DIR__ . '/extension_run_guard.php', true) . '; guardExtensionRun('
            . var_export($source, true) . ', ' . var_export($symbols, true) . ');'
            . ($load === null ? '' : ' require_once ' . var_export($load, true) . ';');
        $process = proc_open([PHP_BINARY, '-n', '-r', $code], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        self::assertIsResource($process, 'php -n did not start');
        stream_get_contents($pipes[1]);
        $errors = (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        return [proc_close($process), $errors];
    }
}
