<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use RuntimeException;
use Polyspec\Orm\Generator;
use Polyspec\Orm\RuntimeModel;

/** Generate one test's fixture models from a contract file and keep their temporary tree until process exit. */
function loadGeneratedFixture(
    string $prefix,
    string $documentName,
    string $namespace,
    string $outputName = 'models'
): void {
    $path = dirname(__DIR__, 3) . '/contracts/fixtures/' . $documentName;
    $document = file_get_contents($path);
    if (!is_string($document)) {
        throw new RuntimeException("cannot read fixture $path");
    }
    loadGeneratedDocumentSets($prefix, [$namespace => [$documentName => $document]], [$namespace => $outputName]);
}

/**
 * Generate one or more independent document sets and keep their shared temporary tree until process exit.
 *
 * Each namespace is a separate manifest, so fixtures that declare the same table name remain isolated. The optional
 * output name map preserves the one-document loader's directory convention.
 *
 * @param array<non-empty-string, array<non-empty-string, string>> $sets
 * @param array<non-empty-string, non-empty-string> $outputNames
 */
function loadGeneratedDocumentSets(string $prefix, array $sets, array $outputNames = []): void
{
    $work = sys_get_temp_dir() . '/' . $prefix . getmypid() . '-' . bin2hex(random_bytes(6));
    if (!mkdir($work, 0o700, true)) {
        throw new RuntimeException("cannot create $work");
    }
    register_shutdown_function(static function () use ($work): void {
        removeGeneratedFixtureTree($work);
    });

    foreach ($sets as $namespace => $documents) {
        $outputName = $outputNames[$namespace] ?? str_replace('\\', '_', $namespace);
        $output = "$work/$outputName";
        Generator::generate(RuntimeModel::build(RuntimeModel::parse($documents)), $output, $namespace);
        requireGeneratedClasses($output);
        require "$output/bootstrap.php";
    }
}

/** Remove the generated fixture tree without a shell process at shutdown. */
function removeGeneratedFixtureTree(string $path): void
{
    if (!is_dir($path)) {
        if (file_exists($path)) {
            unlink($path);
        }
        return;
    }
    foreach (new \FilesystemIterator($path) as $entry) {
        $child = $entry->getPathname();
        if ($entry->isDir() && !$entry->isLink()) {
            removeGeneratedFixtureTree($child);
        } else {
            unlink($child);
        }
    }
    rmdir($path);
}

/**
 * The lifecycle of a database test case on the three drivers whose models are generated from a contract fixture: it
 * brings the drivers (ThreeDrivers) and the database assertions (DatabaseTestAssertions) and loads the models of
 * generatedFixture() before the first case.
 */
trait GeneratedFixtureLifecycle
{
    use ThreeDrivers;
    use DatabaseTestAssertions;

    /**
     * @return array{
     *     prefix: non-empty-string,
     *     documentName: non-empty-string,
     *     namespace: non-empty-string,
     *     outputName?: non-empty-string
     * }
     */
    abstract protected static function generatedFixture(): array;

    public static function setUpBeforeClass(): void
    {
        $fixture = static::generatedFixture();
        loadGeneratedFixture(
            $fixture['prefix'],
            $fixture['documentName'],
            $fixture['namespace'],
            $fixture['outputName'] ?? 'models'
        );
    }
}
