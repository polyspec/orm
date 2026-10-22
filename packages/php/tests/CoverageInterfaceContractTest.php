<?php

declare(strict_types=1);

// interface_contract feature coverage: runs
// `node tests/interfaces/check/main.mts -language php` at the repository root and requires exit code 0.


use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;

#[Large]
final class CoverageInterfaceContractTest extends TestCase
{
    // Requirements: INT-17, INT-18, INT-19, INT-57, INT-61, INT-64.
    public function testInterfaceSymbols(): void
    {
        [$status, $stdout, $stderr] = coverageProcess(
            ['node', 'tests/interfaces/check/main.mts', '-language', 'php'],
            dirname(__DIR__, 3)
        );
        Assert::assertTrue($status === 0, "interface check exited $status: $stderr$stdout");
    }
}
