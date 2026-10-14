<?php
declare(strict_types=1);
// interface_contract feature coverage: 저장소 root에서
// `node tests/interfaces/check/main.mts -language php`를 실행하고 종료 코드 0을 요구한다.

require_once __DIR__ . '/coverage_cases.php';

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;

#[Large]
final class CoverageInterfaceContractTest extends TestCase
{
    public function test_interface_symbols(): void
    {
        [$status, $stdout, $stderr] = coverageProcess(['node', 'tests/interfaces/check/main.mts', '-language', 'php'], dirname(__DIR__, 3));
        Assert::assertTrue($status === 0, "interface check exited $status: $stderr$stdout");
    }
}
