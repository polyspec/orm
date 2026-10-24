<?php

declare(strict_types=1);

// Feature coverage helper shared by packages/php/tests/Coverage*Test.php (scripts/features/coverage.mts
// runs those test methods with PHPUnit).

use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Assert;

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

/** Reads from the selected database's catalog whether a table exists. */
function coverageTableExists(Db $db, string $table): bool
{
    $sql = match ($db->driver()) {
        'mysql' => 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        'postgres' => 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND '
            . 'table_name = ?',
        'sqlite' => "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
    };
    $st = $db->pdo()->prepare($sql);
    $st->execute([$table]);
    return (int) $st->fetchColumn() === 1;
}

/** @return iterable<string, array{string}> */
function coverageDatabaseDrivers(): iterable
{
    foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
        yield $driver => [$driver];
    }
}

/**
 * The coverage items of a test file from the feature resolver: one [database, dsn] per declared database by default,
 * or the exact ORM_FEATURE_DATABASE assigned to this owner run. A selected database uses its declared DSN variable.
 *
 * @return list<array{string, ?string}>
 */
function coverageItemsOf(string $testFile): array
{
    $root = realpath(dirname(__DIR__, 3));
    $relative = substr((string) realpath($testFile), strlen((string) $root) + 1);
    $command = ['node', "$root/scripts/features/coverage.mts", '--items', $relative];
    $selectedDatabase = getenv('ORM_FEATURE_DATABASE');
    if (is_string($selectedDatabase) && $selectedDatabase !== '') {
        $command[] = '--database';
        $command[] = $selectedDatabase;
    }
    $process = proc_open(
        $command,
        [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes,
        $root
    );
    if (!is_resource($process)) {
        throw new RuntimeException("cannot run the coverage resolver for $relative");
    }
    $text = stream_get_contents($pipes[1]);
    $errors = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $status = proc_close($process);
    if ($status !== 0) {
        throw new RuntimeException("coverage items of $relative: " . trim((string) $errors));
    }
    $items = [];
    foreach (json_decode((string) $text, true, 512, JSON_THROW_ON_ERROR) as $item) {
        $items[] = [$item['database'], $item['dsn'] ?? null];
    }
    return $items;
}

/** The item that the running test method selected; a test method selects each item of the resolver in turn. */
function selectCoverageItem(array $item): void
{
    $GLOBALS['orm_coverage_item'] = $item;
}

/** @return array{string, ?string} the item the running test method selected */
function coverageItem(): array
{
    $item = $GLOBALS['orm_coverage_item'] ?? null;
    if (!is_array($item)) {
        throw new RuntimeException(
            'no coverage item is selected; a test method runs each item of coverageItemsOf(__FILE__)'
        );
    }
    return $item;
}

/** Connects with the AES and blind index keys of the seeded bench database (scripts/bench-db.sh). */
function coverageConnect(string $dsn): Db
{
    return \Polyspec\Orm\Tests\Model\connect(
        $dsn,
        new Config(aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index')
    );
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

/** The OrmException code thrown by $fn. Other exceptions propagate as they are; on success, 'no error'. */
function coverageCode(Closure $fn): string
{
    try {
        $fn();
    } catch (OrmException $e) {
        return $e->code_;
    }
    return 'no error';
}

/**
 * Runs $body, and whether it succeeds or fails, rolls back the rows the test wrote with $restore.
 * If both steps fail, reports both errors together.
 */
function coverageRestoring(Closure $body, Closure $restore): void
{
    try {
        $body();
    } catch (Throwable $failure) {
        try {
            $restore();
        } catch (Throwable $cleanup) {
            throw new RuntimeException(
                'case failed: ' . $failure->getMessage() . '; restore failed: ' . $cleanup->getMessage(),
                0,
                $failure
            );
        }
        throw $failure;
    }
    $restore();
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
    while ($open !== []) {
        $read = array_values($open);
        $write = null;
        $except = null;
        if (stream_select($read, $write, $except, null) === false) {
            throw new RuntimeException('cannot read the output of ' . $command[0]);
        }
        foreach ($open as $index => $pipe) {
            if (!in_array($pipe, $read, true)) {
                continue;
            }
            $chunk = fread($pipe, 65536);
            if ($chunk === false) {
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
