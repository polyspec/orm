<?php
declare(strict_types=1);

/*
 * tests/testcase.php의 testcase_run과 TestCases가 case마다 시작, 단계, 결과와 경과 시간을 이
 * 순서로 출력하고, 기한이 지난 case를 FAIL로 보고하는지 하위 process로 확인한다.
 *
 * Usage: php tests/testcase_test.php
 */

require __DIR__ . '/testcase.php';

const ELAPSED = 'elapsed=[0-9.]+(µs|ms|s|m[0-9.]+s)';

/**
 * fixture를 하위 PHP process로 실행한다. 멈춘 fixture가 이 test를 붙잡지 않도록 30초 안에
 * 끝나지 않으면 process를 끝내고 실패한다.
 *
 * @param list<string> $options php 명령의 option(-d 설정)
 * @return array{int, string} 종료 코드와 stdout
 */
function fixture(string $source, array $options = []): array
{
    $file = tempnam(sys_get_temp_dir(), 'orm-testcase-') . '.php';
    file_put_contents($file, "<?php\ndeclare(strict_types=1);\nrequire " . var_export(__DIR__ . '/testcase.php', true) . ";\n" . $source);
    try {
        $process = proc_open([PHP_BINARY, ...$options, $file], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $output = ['', ''];
        $limit = hrtime(true) + 30 * 1_000_000_000;
        $open = [1 => $pipes[1], 2 => $pipes[2]];
        while ($open !== []) {
            $left = ($limit - hrtime(true)) / 1e9;
            if ($left <= 0) {
                proc_terminate($process, 9);
                proc_close($process);
                throw new RuntimeException("fixture did not exit within 30s\n{$output[0]}");
            }
            $read = array_values($open);
            $write = $except = null;
            if (stream_select($read, $write, $except, (int) $left, (int) (($left - floor($left)) * 1e6)) === false) {
                throw new RuntimeException('stream_select failed');
            }
            foreach ($read as $stream) {
                $index = array_search($stream, $open, true);
                $chunk = fread($stream, 65536);
                if ($chunk === '' || $chunk === false) {
                    fclose($stream);
                    unset($open[$index]);
                    continue;
                }
                $output[$index - 1] .= $chunk;
            }
        }
        return [proc_close($process), $output[0]];
    } finally {
        unlink($file);
    }
}

/** $output에 $patterns가 이 순서로 한 줄씩 나타나는지 확인한다. */
function in_order(string $output, string ...$patterns): void
{
    $lines = array_map('trim', explode("\n", $output));
    $at = 0;
    foreach ($patterns as $pattern) {
        while ($at < count($lines) && preg_match('~^' . $pattern . '$~u', $lines[$at]) !== 1) {
            $at++;
        }
        if ($at >= count($lines)) {
            throw new RuntimeException("no line matching $pattern in order\n$output");
        }
        $at++;
    }
}

$cases = new TestCases();
$cases->run('testcase/duration', TESTCASE_COMPUTE, static function (): void {
    foreach ([[0.0005, '500µs'], [0.012, '12ms'], [0.0009996, '1ms'], [0.9996, '1s'], [1.34, '1.34s'], [60.0, '1m0s'], [75.03, '1m15.03s'], [3600.0, '1h0m0s']] as [$seconds, $want]) {
        if (testcase_duration($seconds) !== $want) {
            throw new RuntimeException("duration $seconds: " . testcase_duration($seconds) . ", want $want");
        }
    }
});
$cases->run('testcase/run', TESTCASE_PROCESS, static function (): void {
    [$code, $stdout] = fixture(<<<'PHP'
$cases = new TestCases();
$cases->run('fixture/pass', 60.0, static function (callable $step): void { $step('first step'); });
$cases->run('fixture/fail', 60.0, static function (): void { throw new RuntimeException('fixture failure reason'); });
$cases->run('fixture/stuck', 1.0, static function (): void { while (true) { usleep(1000); } });
$cases->run('fixture/blocked', 1.0, static function (): void { sleep(60); });
$cases->finish();
PHP);
    if ($code !== 1) {
        throw new RuntimeException("fixture exit $code, want 1\n$stdout");
    }
    in_order($stdout, 'RUN fixture/pass deadline=1m0s', 'STEP fixture/pass ' . ELAPSED . ': first step', 'PASS fixture/pass ' . ELAPSED);
    in_order($stdout, 'RUN fixture/fail deadline=1m0s', 'FAIL fixture/fail ' . ELAPSED . ': fixture failure reason');
    in_order($stdout, 'RUN fixture/stuck deadline=1s', 'FAIL fixture/stuck ' . ELAPSED . ': deadline 1s exceeded');
    in_order($stdout, 'RUN fixture/blocked deadline=1s', 'FAIL fixture/blocked ' . ELAPSED . ': deadline 1s exceeded', '3 case\(s\) failed');
});
$cases->run('testcase/stuck-past-grace', TESTCASE_PROCESS, static function (): void {
    [$code, $stdout] = fixture(<<<'PHP'
// 끊김을 무시하는 case다. handler는 TestCaseDeadline을 한 번만 던지므로, 그 error가 어느
// 반복에서 오든 try 안에 있도록 loop 전체를 try에 둔다.
testcase_run('fixture/ignores', 1.0, static function (): void {
    try {
        while (true) { usleep(1000); }
    } catch (TestCaseDeadline) {
        while (true) { usleep(1000); }
    }
});
PHP);
    if ($code !== 1) {
        throw new RuntimeException("fixture exit $code, want 1\n$stdout");
    }
    in_order($stdout, 'RUN fixture/ignores deadline=1s', 'FAIL fixture/ignores ' . ELAPSED . ': deadline 1s exceeded and the case did not stop');
});
$cases->run('testcase/sections', TESTCASE_PROCESS, static function (): void {
    [$code, $stdout] = fixture(<<<'PHP'
testcase_begin('fixture/section-pass', 60.0);
testcase_step('section step');
testcase_end();
testcase_begin('fixture/section-checks', 60.0);
testcase_end('2 check(s) failed');
testcase_begin('fixture/section-fail', 60.0);
throw new RuntimeException("section failure reason\nsecond line");
PHP);
    if ($code !== 255) {
        throw new RuntimeException("fixture exit $code, want 255\n$stdout");
    }
    in_order($stdout, 'RUN fixture/section-pass deadline=1m0s', 'STEP fixture/section-pass ' . ELAPSED . ': section step', 'PASS fixture/section-pass ' . ELAPSED);
    in_order($stdout, 'RUN fixture/section-checks deadline=1m0s', 'FAIL fixture/section-checks ' . ELAPSED . ': 2 check\\(s\\) failed');
    in_order($stdout, 'RUN fixture/section-fail deadline=1m0s', 'FAIL fixture/section-fail ' . ELAPSED . ': section failure reason');
    [$code, $stdout] = fixture(<<<'PHP'
testcase_begin('fixture/section-stuck', 1.0);
while (true) { usleep(1000); }
PHP);
    if ($code !== 255) {
        throw new RuntimeException("fixture exit $code, want 255\n$stdout");
    }
    in_order($stdout, 'RUN fixture/section-stuck deadline=1s', 'FAIL fixture/section-stuck ' . ELAPSED . ': deadline 1s exceeded');
});
// pcntl이 없는 PHP(공식 image)에서는 끝난 case의 경과 시간이 기한을 넘으면 FAIL이다.
$cases->run('testcase/without-pcntl', TESTCASE_PROCESS, static function (): void {
    [$code, $stdout] = fixture(<<<'PHP'
$cases = new TestCases();
$cases->run('fixture/fast', 60.0, static function (): void {});
$cases->run('fixture/late', 1.0, static function (): void { usleep(1_200_000); });
testcase_begin('fixture/late-section', 1.0);
usleep(1_200_000);
testcase_end();
PHP, ['-d', 'disable_functions=pcntl_alarm,pcntl_signal,pcntl_async_signals']);
    if ($code !== 255) {
        throw new RuntimeException("fixture exit $code, want 255\n$stdout");
    }
    in_order($stdout, 'RUN fixture/fast deadline=1m0s', 'PASS fixture/fast ' . ELAPSED);
    in_order($stdout, 'RUN fixture/late deadline=1s', 'FAIL fixture/late ' . ELAPSED . ': deadline 1s exceeded');
    in_order($stdout, 'RUN fixture/late-section deadline=1s', 'FAIL fixture/late-section ' . ELAPSED . ': deadline 1s exceeded');
    // 끊을 signal이 없으므로 기한에 TESTCASE_GRACE를 더한 시간까지 끝나지 않은 case는 FAIL 줄과
    // 함께 process가 끝난다.
    foreach ([
        'fixture/stuck' => "testcase_run('fixture/stuck', 1.0, static function (): void { while (true) { usleep(1000); } });\necho \"after stuck\\n\";",
        'fixture/stuck-section' => "testcase_begin('fixture/stuck-section', 1.0);\nwhile (true) { usleep(1000); }",
    ] as $name => $source) {
        [$code, $stdout] = fixture($source, ['-d', 'disable_functions=pcntl_alarm,pcntl_signal,pcntl_async_signals']);
        if ($code === 0) {
            throw new RuntimeException("$name fixture exit 0, want a failure\n$stdout");
        }
        in_order($stdout, "RUN $name deadline=1s", "FAIL $name " . ELAPSED . ': deadline 1s exceeded and the case did not stop');
        if (str_contains($stdout, 'after stuck')) {
            throw new RuntimeException("$name: the script continued after the stuck case\n$stdout");
        }
    }
});
$cases->finish();
