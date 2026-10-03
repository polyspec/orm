<?php
declare(strict_types=1);

/*
 * PHP test와 check runner가 case마다 쓰는 진행 보고 형식과 case별 기한이다
 * (internal/testcase의 Go 형식, tests/testcase.mjs와 같다).
 *
 *   RUN <case> deadline=<기한>
 *   STEP <case> elapsed=<경과>: <단계>
 *   PASS <case> elapsed=<경과>
 *   FAIL <case> elapsed=<경과>: <이유>
 *
 * 기한은 wall-clock 시간이다. 멈춘 case를 끝내는 timer이고 case 자신의 계산 시간을 재는
 * 제한이 아니기 때문이다(AGENTS.md testing rule). pcntl이 있으면 기한에 SIGALRM이 case를
 * TestCaseDeadline으로 끊고, 그 뒤 TESTCASE_GRACE 안에 끝나지 않으면 FAIL 줄을 출력하고
 * process를 끝낸다. pcntl이 없는 PHP(공식 image)에서는 case마다 watchdog process가 기한에
 * TESTCASE_GRACE를 더한 시간까지 끝나지 않은 case의 FAIL 줄을 출력하고 process를 끝낸다.
 * SIGALRM은 초 단위이므로, 그리고 pcntl이 없으면 case를 기한에 끊을 수 없으므로 끝난
 * case의 경과 시간이 기한을 넘었으면 FAIL로 보고한다.
 */

// 기한의 등급(초)이다. case는 자기가 하는 일에 맞는 등급을 쓰고, 등급보다 오래 걸리는 일은
// 그 기준을 주석에 밝힌 자기 기한을 쓴다.
// COMPUTE: memory 안의 계산과 repository file 읽기만 하는 case. 가장 큰 것(dbspec stress 문서의
// parse와 emit)도 몇 초 안에 끝나므로 1분을 넘긴 case는 멈춘 것이다.
const TESTCASE_COMPUTE = 60.0;
// DATABASE: TEST_ENV의 database에 연결해 정해진 수의 statement를 실행하는 case. database를
// 만들고 지우는 일과 공유 server에서 lock을 기다리는 시간까지 2분이면 넉넉하다.
const TESTCASE_DATABASE = 120.0;
// PROCESS: php, go, node 같은 하위 process를 실행하는 case. `go run`은 build cache가 비었을 때
// compile에 몇 분이 걸린다.
const TESTCASE_PROCESS = 300.0;
// GRACE: 기한에 끊긴 case가 정리를 마치기를 기다리는 시간이다.
const TESTCASE_GRACE = 5.0;

/** 기한을 넘긴 case를 끊는 error다. */
final class TestCaseDeadline extends RuntimeException
{
}

/** 초를 Go time.Duration의 String 형식(1m0s, 1.5s, 12ms)으로 쓴다. */
function testcase_duration(float $seconds): string
{
    $ms = $seconds * 1000;
    // 반올림한 값으로 단위를 고른다. 999.6ms는 1000ms가 아니라 1s다.
    if (round($ms * 1000) < 1000) {
        return round($ms * 1000) . 'µs';
    }
    if (round($ms) < 1000) {
        return round($ms) . 'ms';
    }
    $total = round($ms) / 1000;
    $trim = static fn(float $v): string => rtrim(rtrim(number_format($v, 3, '.', ''), '0'), '.');
    if ($total < 60) {
        return $trim($total) . 's';
    }
    $hours = intdiv((int) $total, 3600);
    $minutes = intdiv((int) $total % 3600, 60);
    $rest = $total - $hours * 3600 - $minutes * 60;
    return ($hours > 0 ? $hours . 'h' : '') . $minutes . 'm' . $trim($rest) . 's';
}

/** 보고 줄 하나를 바로 stdout에 쓴다. */
function testcase_emit(string $line): void
{
    fwrite(STDOUT, $line . "\n");
    fflush(STDOUT);
}

/**
 * pcntl이 없을 때 case 하나를 지키는 watchdog process를 시작한다. watchdog은 stdin이 닫히기를
 * $deadline + TESTCASE_GRACE초까지 기다리고, 그때까지 닫히지 않으면 FAIL 줄을 출력하고 이
 * process를 SIGTERM으로 끝낸다. testcase_watchdog_stop이 stdin을 닫아 watchdog을 끝내고, 이
 * process가 먼저 끝나도 stdin이 닫혀 watchdog이 끝난다. pcntl이 있으면 null이다.
 *
 * @return array{resource, resource}|null watchdog process와 그 stdin
 */
function testcase_watchdog(string $name, float $deadline): ?array
{
    if (function_exists('pcntl_alarm') && function_exists('pcntl_signal')) {
        return null;
    }
    $code = 'require $argv[1]; testcase_watchdog_wait($argv[2], (float) $argv[3], (int) $argv[4]);';
    $process = proc_open(
        [PHP_BINARY, '-r', $code, __FILE__, $name, (string) $deadline, (string) getmypid()],
        [0 => ['pipe', 'r'], 1 => STDOUT, 2 => STDERR],
        $pipes,
    );
    if ($process === false) {
        throw new RuntimeException("testcase $name: the watchdog process did not start");
    }
    return [$process, $pipes[0]];
}

/** watchdog의 stdin을 닫고 watchdog이 끝나기를 기다린다. */
function testcase_watchdog_stop(?array $watchdog): void
{
    if ($watchdog === null) {
        return;
    }
    fclose($watchdog[1]);
    proc_close($watchdog[0]);
}

/** watchdog process의 본문이다. testcase_watchdog을 본다. */
function testcase_watchdog_wait(string $name, float $deadline, int $parent): void
{
    $started = hrtime(true);
    $limit = $deadline + TESTCASE_GRACE;
    while (($left = $limit - (hrtime(true) - $started) / 1e9) > 0) {
        $read = [STDIN];
        $write = $except = null;
        $ready = @stream_select($read, $write, $except, (int) $left, (int) (($left - floor($left)) * 1e6));
        // stdin은 닫힐 때만 읽을 수 있게 된다(case가 끝났거나 process가 끝났다).
        if ($ready === false || ($ready > 0 && (string) fread(STDIN, 1) === '')) {
            return;
        }
    }
    testcase_emit("FAIL $name elapsed=" . testcase_duration((hrtime(true) - $started) / 1e9) . ': deadline '
        . testcase_duration($deadline) . ' exceeded and the case did not stop');
    // posix가 없으면 sh의 내장 kill을 쓴다. kill binary가 없는 image도 있다.
    if (function_exists('posix_kill')) {
        posix_kill($parent, 15);
        return;
    }
    proc_close(proc_open(['sh', '-c', 'kill -TERM "$0"', (string) $parent], [], $pipes));
}

/**
 * case 하나를 $deadline(초) 아래에서 실행하고 시작, 단계, 결과, 경과 시간을 출력한다.
 * $body는 단계 줄을 출력하는 callable(string): void를 받는다. 통과하면 true, 실패하면
 * false를 돌려준다. process의 종료 코드는 호출자가 정한다.
 *
 * @param callable(callable(string): void): mixed $body
 */
function testcase_run(string $name, float $deadline, callable $body): bool
{
    if (!($deadline > 0)) {
        throw new InvalidArgumentException("testcase_run $name: deadline $deadline is not positive");
    }
    $started = hrtime(true);
    $elapsed = static fn(): string => testcase_duration((hrtime(true) - $started) / 1e9);
    $step = static function (string $text) use ($name, $elapsed): void {
        testcase_emit("STEP $name elapsed={$elapsed()}: $text");
    };
    testcase_emit("RUN $name deadline=" . testcase_duration($deadline));
    $alarm = function_exists('pcntl_alarm') && function_exists('pcntl_signal');
    if ($alarm) {
        pcntl_async_signals(true);
        $expired = false;
        // SIGALRM이 막힌 system call을 끊도록 restart하지 않는다.
        pcntl_signal(SIGALRM, static function () use (&$expired, $name, $deadline, $elapsed): void {
            if ($expired) {
                testcase_emit("FAIL $name elapsed={$elapsed()}: deadline " . testcase_duration($deadline) . ' exceeded and the case did not stop');
                exit(1);
            }
            $expired = true;
            pcntl_alarm((int) ceil(TESTCASE_GRACE));
            throw new TestCaseDeadline('deadline ' . testcase_duration($deadline) . ' exceeded');
        }, false);
        pcntl_alarm(max(1, (int) ceil($deadline)));
    }
    $watchdog = testcase_watchdog($name, $deadline);
    try {
        $body($step);
        // SIGALRM은 초 단위이므로 끝난 case의 경과 시간도 기한과 비교한다.
        $seconds = (hrtime(true) - $started) / 1e9;
        if ($seconds > $deadline) {
            throw new TestCaseDeadline('deadline ' . testcase_duration($deadline) . ' exceeded');
        }
        if ($alarm) {
            pcntl_alarm(0);
        }
        testcase_emit("PASS $name elapsed={$elapsed()}");
        return true;
    } catch (Throwable $error) {
        if ($alarm) {
            pcntl_alarm(0);
        }
        $reason = $error->getMessage() !== '' ? $error->getMessage() : get_class($error);
        // 전체 error와 stack은 stderr로, 이유는 FAIL 줄로 간다.
        fwrite(STDERR, "$name: $error\n");
        testcase_emit("FAIL $name elapsed={$elapsed()}: $reason");
        return false;
    } finally {
        testcase_watchdog_stop($watchdog);
        if ($alarm) {
            pcntl_signal(SIGALRM, SIG_DFL);
        }
    }
}

/** 열린 구역 case: [name, deadline, started hrtime, watchdog] 또는 null. */
$GLOBALS['testcase_section'] = null;

/**
 * 함수로 나뉘지 않은 test 코드 구역을 case로 시작하고 RUN 줄을 출력한다. testcase_end가
 * PASS 줄을 출력한다. 구역 안에서 던진 error가 script를 끝내면 shutdown 때 그 message와
 * 함께 FAIL 줄을 출력한다. pcntl이 있으면 기한에 TestCaseDeadline을 던지고, 그 뒤
 * TESTCASE_GRACE 안에 끝나지 않으면 FAIL 줄을 출력하고 process를 끝낸다.
 */
function testcase_begin(string $name, float $deadline): void
{
    if ($GLOBALS['testcase_section'] !== null) {
        throw new LogicException("case $name began inside case {$GLOBALS['testcase_section'][0]}");
    }
    if (!($deadline > 0)) {
        throw new InvalidArgumentException("testcase_begin $name: deadline $deadline is not positive");
    }
    static $registered = false;
    if (!$registered) {
        $registered = true;
        register_shutdown_function(static function (): void {
            $open = $GLOBALS['testcase_section'];
            if ($open === null) {
                return;
            }
            $GLOBALS['testcase_section'] = null;
            $error = error_get_last();
            $reason = 'the process ended inside the case';
            if ($error !== null) {
                // 잡히지 않은 error는 "Uncaught <class>: <message> in <file>:<line>"로 남는다. 여러 줄
                // message는 첫 줄만 쓰고, 전체는 PHP가 그 위에 출력한다.
                $reason = strtok($error['message'], "\n");
                $reason = preg_replace(['/^Uncaught [^:]+: /', '/ in \S+:\d+$/'], '', $reason);
            }
            testcase_emit("FAIL {$open[0]} elapsed=" . testcase_duration((hrtime(true) - $open[2]) / 1e9) . ": $reason");
        });
    }
    $GLOBALS['testcase_section'] = [$name, $deadline, hrtime(true)];
    testcase_emit("RUN $name deadline=" . testcase_duration($deadline));
    if (function_exists('pcntl_alarm') && function_exists('pcntl_signal')) {
        pcntl_async_signals(true);
        $expired = false;
        pcntl_signal(SIGALRM, static function () use (&$expired, $name, $deadline): void {
            $open = $GLOBALS['testcase_section'];
            $elapsed = $open === null ? '' : testcase_duration((hrtime(true) - $open[2]) / 1e9);
            if ($expired) {
                $GLOBALS['testcase_section'] = null;
                testcase_emit("FAIL $name elapsed=$elapsed: deadline " . testcase_duration($deadline) . ' exceeded and the case did not stop');
                exit(1);
            }
            $expired = true;
            pcntl_alarm((int) ceil(TESTCASE_GRACE));
            throw new TestCaseDeadline('deadline ' . testcase_duration($deadline) . ' exceeded');
        }, false);
        pcntl_alarm(max(1, (int) ceil($deadline)));
    }
    $GLOBALS['testcase_section'][3] = testcase_watchdog($name, $deadline);
}

/** 열린 구역 case의 단계 줄을 경과 시간과 함께 출력한다. */
function testcase_step(string $text): void
{
    $open = $GLOBALS['testcase_section'];
    if ($open === null) {
        throw new LogicException('testcase_step outside a case');
    }
    testcase_emit("STEP {$open[0]} elapsed=" . testcase_duration((hrtime(true) - $open[2]) / 1e9) . ": $text");
}

/**
 * 열린 구역 case를 끝낸다. $failure가 null이면 PASS, 아니면 그 이유로 FAIL 줄을 출력한다.
 * pcntl이 없으면 기한을 넘긴 구역을 여기서 실패시킨다.
 */
function testcase_end(?string $failure = null): void
{
    $open = $GLOBALS['testcase_section'];
    if ($open === null) {
        throw new LogicException('testcase_end without a case');
    }
    $alarm = function_exists('pcntl_alarm');
    if ($alarm) {
        pcntl_alarm(0);
        pcntl_signal(SIGALRM, SIG_DFL);
    }
    testcase_watchdog_stop($open[3]);
    $GLOBALS['testcase_section'][3] = null;
    // SIGALRM은 초 단위이므로 끝난 구역의 경과 시간도 기한과 비교한다.
    $seconds = (hrtime(true) - $open[2]) / 1e9;
    if ($seconds > $open[1]) {
        throw new TestCaseDeadline('deadline ' . testcase_duration($open[1]) . ' exceeded');
    }
    $GLOBALS['testcase_section'] = null;
    if ($failure !== null) {
        testcase_emit("FAIL {$open[0]} elapsed=" . testcase_duration($seconds) . ": $failure");
        return;
    }
    testcase_emit("PASS {$open[0]} elapsed=" . testcase_duration($seconds));
}

/**
 * test script 하나의 case를 차례로 실행하는 runner다. run은 testcase_run으로 case 하나를
 * 실행하고, finish는 실패한 case가 있으면 그 수를 출력하고 종료 코드 1로 끝낸다.
 */
final class TestCases
{
    private int $failed = 0;

    /** @param callable(callable(string): void): mixed $body */
    public function run(string $name, float $deadline, callable $body): bool
    {
        $passed = testcase_run($name, $deadline, $body);
        if (!$passed) {
            $this->failed++;
        }
        return $passed;
    }

    public function failed(): int
    {
        return $this->failed;
    }

    public function finish(): void
    {
        if ($this->failed > 0) {
            testcase_emit("{$this->failed} case(s) failed");
            exit(1);
        }
    }
}
