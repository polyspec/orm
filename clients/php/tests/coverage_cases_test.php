<?php
// feature coverage case 실행기(clients/php/tests/coverage_cases.php)의 unit test다. 실행기는
// clients/php/tests/coverage_*.php가 함께 쓰므로, 그 변경은 모든 기능의 coverage가 아니라 이
// test가 검사한다(contracts/features.json의 helpers). 전체 coverage는 make check가 실행한다.
// Usage: php clients/php/tests/coverage_cases_test.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once __DIR__ . '/coverage_cases.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Orm\Code;
use Orm\OrmException;

/** $fn이 던진 RuntimeException의 message다. 던지지 않으면 실패한다. */
function thrownMessage(Closure $fn): string
{
    try {
        $fn();
    } catch (RuntimeException $e) {
        return $e->getMessage();
    }
    throw new RuntimeException('expected a RuntimeException');
}

function expectSame(mixed $got, mixed $want, string $what): void
{
    if ($got !== $want) {
        throw new RuntimeException("$what: got " . var_export($got, true) . ', want ' . var_export($want, true));
    }
}

$failed = 0;
$case = static function (string $name, Closure $body) use (&$failed): void {
    if (!testcase_run("coverage_cases/$name", TESTCASE_COMPUTE, static fn (callable $step) => $body($step))) {
        $failed++;
    }
};

$case('runs-requested-cases-in-order', static function (): void {
    $ran = [];
    $cases = ['a' => static function () use (&$ran): void { $ran[] = 'a'; }, 'b' => static function () use (&$ran): void { $ran[] = 'b'; }];
    ob_start();
    runCoverageCases(['x.php', 'b', 'a'], $cases);
    $output = ob_get_clean();
    expectSame($ran, ['b', 'a'], 'run order');
    expectSame($output, "CASE b PASS\nCASE a PASS\n", 'output');
});

$case('refuses-missing-repeated-and-unknown-ids', static function (): void {
    $cases = ['a' => static function (): void {}];
    expectSame(thrownMessage(static fn () => runCoverageCases(['x.php'], $cases)), 'usage: x.php a', 'no id');
    expectSame(thrownMessage(static fn () => runCoverageCases(['x.php', 'a', 'a'], $cases)), 'duplicate case ID in a a', 'repeated id');
    expectSame(thrownMessage(static fn () => runCoverageCases(['x.php', 'z'], $cases)), 'unknown case z; the cases are a', 'unknown id');
});

$case('stops-at-a-failing-case-without-its-pass-line', static function (): void {
    $cases = ['a' => static function (): void { throw new RuntimeException('a failed'); }, 'b' => static function (): void {}];
    ob_start();
    $message = thrownMessage(static fn () => runCoverageCases(['x.php', 'a', 'b'], $cases));
    $output = ob_get_clean();
    expectSame($message, 'a failed', 'failure');
    expectSame($output, '', 'output after a failure');
});

$case('reports-error-codes-and-restore-failures', static function (): void {
    expectSame(coverageCode(static function (): void { throw new OrmException(Code::CONFIG, 'bad'); }), Code::CONFIG, 'code');
    expectSame(coverageCode(static function (): void {}), 'no error', 'no error');
    expectSame(thrownMessage(static fn () => coverageWant(false, 'wanted')), 'wanted', 'want');
    $restored = false;
    coverageRestoring(static function (): void {}, static function () use (&$restored): void { $restored = true; });
    expectSame($restored, true, 'restore after success');
    expectSame(thrownMessage(static fn () => coverageRestoring(
        static function (): void { throw new RuntimeException('body'); },
        static function (): void { throw new RuntimeException('cleanup'); },
    )), 'case failed: body; restore failed: cleanup', 'both failures');
});

$case('requires-the-selected-database', static function (): void {
    putenv('ORM_FEATURE_DATABASE');
    putenv('ORM_FEATURE_DSN');
    expectSame(thrownMessage(static fn () => coverageDatabase()), 'ORM_FEATURE_DATABASE and ORM_FEATURE_DSN are required', 'missing');
    putenv('ORM_FEATURE_DATABASE=sqlite');
    putenv('ORM_FEATURE_DSN=sqlite:///tmp/x.sqlite');
    expectSame(coverageDatabase(), ['sqlite', 'sqlite:///tmp/x.sqlite'], 'selected');
});

$case('runs-a-child-process', static function (): void {
    [$status, $stdout, $stderr] = coverageProcess([PHP_BINARY, '-r', 'echo "out"; fwrite(STDERR, "err"); exit(3);'], __DIR__);
    expectSame([$status, $stdout, $stderr], [3, 'out', 'err'], 'child');
});

exit($failed === 0 ? 0 : 1);
