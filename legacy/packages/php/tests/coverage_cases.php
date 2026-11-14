<?php

declare(strict_types=1);

// Feature coverage helper shared by packages/php/tests/Coverage*Test.php (scripts/features/coverage.mts
// runs those test methods with PHPUnit).

use PHPUnit\Framework\Assert;
use Polyspec\Orm\CatalogColumn;
use Polyspec\Orm\CatalogTableMetadata;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;

/** Fails in extension mode if a client entry point has fallen back to its PHP implementation. */
function coverageAssertEntryClassesAreInternal(): void
{
    if (getenv('ORM_PHP_MODE') !== 'extension') {
        return;
    }
    foreach (['Polyspec\\Orm\\Db', 'Polyspec\\Orm\\Planner'] as $entry) {
        Assert::assertTrue((new ReflectionClass($entry))->isInternal(), "$entry is the extension class");
    }
}

/** The metadata of a table whose one column has a name that is not UTF-8. */
function coverageNonUtf8ColumnMetadata(): CatalogTableMetadata
{
    return new CatalogTableMetadata(
        ['namespace' => 'main', 'name' => 'sample'],
        'table',
        [new CatalogColumn("\xFF", 'text', false, false, false, null, false)],
        ["\xFF"],
        true,
    );
}

/** The read of that metadata fails with ROW_SNAPSHOT_INVALID, whose previous exception is the column name failure. */
function coverageAssertColumnNameFailureIsPrevious(callable $read): void
{
    try {
        $read(coverageNonUtf8ColumnMetadata());
        Assert::fail('a descriptor with a non-UTF-8 column name was accepted');
    } catch (OrmException $error) {
        Assert::assertSame(Code::ROW_SNAPSHOT_INVALID, $error->code_);
        Assert::assertInstanceOf(OrmException::class, $error->getPrevious());
        Assert::assertSame(Code::TABLE_REFERENCE_INVALID, $error->getPrevious()->code_);
    }
}

/** The repository root used by PHP test fixtures. */
function coverageRepositoryRoot(): string
{
    return ormLegacyRoot();
}

/** Reads the JSON of a repository file. Fails if it cannot be read or parsed. */
function coverageJson(string $path, bool $associative = true): mixed
{
    $text = file_get_contents($path);
    if ($text === false) {
        throw new RuntimeException("cannot read $path");
    }
    return json_decode($text, $associative, 512, JSON_THROW_ON_ERROR);
}

/**
 * Runs a child process and returns its exit code, stdout, and stderr. The output does not mix
 * into the test output; the caller puts it in the failure error.
 *
 * @param list<string> $command
 * @param array<string, string>|null $env
 * @return array{int, string, string}
 */
function coverageProcess(array $command, string $cwd, ?array $env = null): array
{
    $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $cwd, $env);
    if (!is_resource($process)) {
        throw new RuntimeException('cannot start ' . $command[0]);
    }
    // Reads stdout and stderr together, so that a full pipe on one side does not block the child.
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);
    $out = ['', ''];
    $open = [1 => $pipes[1], 2 => $pipes[2]];
    $abort = static function () use (&$open, $pipes, $process): void {
        proc_terminate($process, 9);
        foreach ($pipes as $pipe) {
            if (is_resource($pipe)) {
                fclose($pipe);
            }
        }
        $open = [];
        proc_close($process);
    };
    // No clock ends the child (T474): the call waits until its output pipes close.
    while ($open !== []) {
        $read = array_values($open);
        $write = null;
        $except = null;
        $ready = stream_select($read, $write, $except, null);
        if ($ready === false) {
            $abort();
            throw new RuntimeException('cannot read the output of ' . $command[0]);
        }
        foreach ($open as $index => $pipe) {
            if (!in_array($pipe, $read, true)) {
                continue;
            }
            $chunk = fread($pipe, 65536);
            if ($chunk === false) {
                $abort();
                throw new RuntimeException('cannot read the output of ' . $command[0]);
            }
            $out[$index - 1] .= $chunk;
            if (feof($pipe)) {
                fclose($pipe);
                unset($open[$index]);
            }
        }
    }
    return [proc_close($process), $out[0], $out[1]];
}
