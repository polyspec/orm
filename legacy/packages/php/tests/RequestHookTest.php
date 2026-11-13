<?php

// The request hook of the PHP client on SQLite: the shared cases of
// request_hook_cases.php, each a data set named by its case id, on a SQLite
// file of its own under a temporary directory that the test removes on every
// path.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/RequestHookTest.php
// [--filter <case>]
// Requirements: INT-78.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use RuntimeException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\Attributes\PreserveGlobalState;
use PHPUnit\Framework\Attributes\RunTestsInSeparateProcesses;
use PHPUnit\Framework\TestCase;

// The cases generate the models of request_hook.dbs in the namespace RequestHookCase, and the registry holds one class
// for each entity of a manifest, so a process that already ran the request hook recipe, which generates the same
// manifest in its own namespace, refuses them with CONFIG. Each case runs in a process of its own, which does not
// include the files that the parent process included, the generated models of the recipe among them.
#[Medium]
#[RunTestsInSeparateProcesses]
#[PreserveGlobalState(false)]
class RequestHookTest extends TestCase
{
    /** @return iterable<string, array{string}> */
    public static function cases(): iterable
    {
        foreach (array_keys(REQUEST_HOOK_CASES) as $id) {
            yield $id => [$id];
        }
    }

    #[DataProvider('cases')]
    public function testRequestHook(string $case): void
    {
        $work = sys_get_temp_dir() . '/orm-php-request-hook-test-' . getmypid() . '-' . $case;
        if (!mkdir($work, 0o700, true)) {
            throw new RuntimeException("cannot create $work");
        }
        try {
            runRequestHookCase($case, "sqlite://$work/case.sqlite");
        } finally {
            exec('rm -rf ' . escapeshellarg($work));
        }
    }
}
