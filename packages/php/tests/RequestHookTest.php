<?php

// The request hook of the PHP client on SQLite: the shared cases of
// request_hook_cases.php, each a data set named by its case id, on a SQLite
// file of its own under a temporary directory that the test removes on every
// path.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/RequestHookTest.php
// [--filter <case>]
declare(strict_types=1);


use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class RequestHookTest extends TestCase
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
