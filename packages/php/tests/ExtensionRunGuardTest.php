<?php

declare(strict_types=1);

// The extension run guard (extension_run_guard.php, T182-6-19): a run that loads a file of the PHP library fails at its
// end and names the file, and a run that loads none passes. Each case runs a php -n child that registers the guard.

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
    public function testOnlyFilesOfTheFolderCount(): void
    {
        self::assertSame(
            ['/r/packages/php/src/Db.php'],
            librarySourcesLoaded(
                ['/r/packages/php/src/Db.php', '/r/packages/php/srcx/A.php', '/r/vendor/a.php'],
                '/r/packages/php/src'
            )
        );
        self::assertSame([], librarySourcesLoaded(['/r/packages/php/tests/A.php'], '/r/packages/php/src/'));
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
        $code = 'require ' . var_export(__DIR__ . '/extension_run_guard.php', true) . '; guardExtensionRun('
            . var_export($source, true) . ');'
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
