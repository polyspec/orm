<?php

declare(strict_types=1);

// The roots of the checkout for the tests of packages/php and packages/php-ext, found by one rule in place of a count
// of directories, which names another directory when the package moves: ormRepositoryRoot() is the nearest directory,
// from the directory of this file upward, that holds go.work, the tracked workspace file that only the repository root
// holds, as testcase.RepositoryRoot of the Go tests finds it; ormLegacyRoot() is its directory legacy, which holds the
// language implementations and the fixtures and vectors that they read. A checkout without go.work throws, since no
// test that reads the root can run without it.
function ormRepositoryRoot(): string
{
    static $root = null;
    if ($root !== null) {
        return $root;
    }
    $directory = __DIR__;
    while (!is_file($directory . '/go.work')) {
        $parent = dirname($directory);
        if ($parent === $directory) {
            throw new RuntimeException(
                'no directory above ' . __DIR__ . ' holds go.work;'
                . ' run the tests in a checkout of the repository, whose root holds it'
            );
        }
        $directory = $parent;
    }
    return $root = $directory;
}

function ormLegacyRoot(): string
{
    return ormRepositoryRoot() . '/legacy';
}
