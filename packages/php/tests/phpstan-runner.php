<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\TestCase;

/** @return array{int, string, string} exit status, stdout and stderr */
function runPhpstan(
    TestCase $test,
    string $root,
    string $configuration,
    string $autoloadFile,
    string $target,
    string $errorFormat = 'raw'
): array {
    $command = [
        PHP_BINARY,
        "$root/vendor-php/bin/phpstan",
        'analyse',
        '--no-progress',
        '--no-ansi',
        "--error-format=$errorFormat",
        '--configuration',
        $configuration,
        '--level=9',
        '--memory-limit=512M',
        '--autoload-file',
        $autoloadFile,
        $target,
    ];
    $result = OrmGenTestSupport::runProcess($command, $root);
    if ($result === null) {
        $test->fail('phpstan could not start');
    }
    return $result;
}

/** Run PHPStan and fail on any nonzero result or reported finding. */
function assertPhpstanHasNoFindings(
    TestCase $test,
    string $root,
    string $configuration,
    string $autoloadFile,
    string $target
): void {
    [$code, $out, $err] = runPhpstan($test, $root, $configuration, $autoloadFile, $target);
    $findings = array_values(
        array_filter(explode("\n", $out), static fn (string $line): bool => str_contains($line, '[identifier='))
    );
    $test->assertFalse(
        $code !== 0 || $findings !== [],
        "phpstan exited $code with " . count($findings) . " findings:\n" . implode("\n", $findings) . (
            $findings === [] ? "\n$out$err" : ''
        )
    );
}
