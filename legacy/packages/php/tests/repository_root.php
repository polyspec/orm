<?php

declare(strict_types=1);

// The roots of the checkout for the tests of packages/php and packages/php-ext, found by one rule in place of a count
// of directories, which names another directory when the package moves: ormRepositoryRoot() is the nearest directory,
// from the directory of this file upward, that holds go.work and no go.mod, as testcase.RepositoryRoot of the Go tests
// finds it. The go.work of the repository root is the workspace file of the Go modules below it, and the root is not
// itself a module; a go.work beside a go.mod is the workspace of that one module, as a link tool writes it there, so it
// is passed over and the search continues upward. ormLegacyRoot() is the directory legacy of the root, which holds the
// language implementations and the fixtures and vectors that they read. A checkout without such a directory throws,
// since no test that reads the root can run without it.
function ormRepositoryRoot(): string
{
    static $root = null;
    return $root ??= ormRepositoryRootFrom(__DIR__);
}

// The root of the checkout that holds the directory $start, by the rule of ormRepositoryRoot().
function ormRepositoryRootFrom(string $start): string
{
    $directory = $start;
    while (!is_file($directory . '/go.work') || is_file($directory . '/go.mod')) {
        $parent = dirname($directory);
        if ($parent === $directory) {
            throw new RuntimeException(
                'no directory from ' . $start . ' upward holds go.work without go.mod;'
                . ' run the tests in a checkout of the repository, whose root holds it'
            );
        }
        $directory = $parent;
    }
    return $directory;
}

function ormLegacyRoot(): string
{
    return ormRepositoryRoot() . '/legacy';
}
