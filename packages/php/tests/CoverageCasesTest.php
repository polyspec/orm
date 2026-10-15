<?php
// feature coverage helper(packages/php/tests/coverage_cases.php)의 unit test다. helper는
// packages/php/tests/Coverage*Test.php가 함께 쓰므로, 그 변경은 모든 기능의 coverage가 아니라 이
// test가 검사한다(contracts/features.json의 helpers). 전체 coverage는 make check가 실행한다.
declare(strict_types=1);

require_once __DIR__ . '/coverage_cases.php';

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;

#[Small]
final class CoverageCasesTest extends TestCase
{
    public function test_reports_error_codes_and_restore_failures(): void
    {
        $this->assertSame(Code::CONFIG, coverageCode(static function (): void { throw new OrmException(Code::CONFIG, 'bad'); }), 'code');
        $this->assertSame('no error', coverageCode(static function (): void {}), 'no error');
        $restored = false;
        coverageRestoring(static function (): void {}, static function () use (&$restored): void { $restored = true; });
        $this->assertTrue($restored, 'restore after success');
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('case failed: body; restore failed: cleanup');
        coverageRestoring(
            static function (): void { throw new RuntimeException('body'); },
            static function (): void { throw new RuntimeException('cleanup'); },
        );
    }

    public function test_requires_the_selected_database(): void
    {
        $GLOBALS['orm_coverage_item'] = null;
        try {
            coverageItem();
            $this->fail('coverageItem accepted no selected item');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('no coverage item is selected', $e->getMessage(), 'missing');
        }
        selectCoverageItem(['sqlite', 'sqlite:///tmp/x.sqlite']);
        $this->assertSame(['sqlite', 'sqlite:///tmp/x.sqlite'], coverageItem(), 'selected');
        $GLOBALS['orm_coverage_item'] = null;
    }

    public function test_runs_a_child_process(): void
    {
        [$status, $stdout, $stderr] = coverageProcess([PHP_BINARY, '-r', 'echo "out"; fwrite(STDERR, "err"); exit(3);'], __DIR__);
        $this->assertSame([3, 'out', 'err'], [$status, $stdout, $stderr], 'child');
    }
}
