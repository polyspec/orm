<?php
declare(strict_types=1);
// clients/php/tests/coverage_*.php가 함께 쓰는 feature coverage case 실행기다
// (scripts/features/coverage.mjs). script는 인자의 case ID만 실행하고 case마다
// `CASE <id> PASS` 한 줄을 출력한다. 실패한 case는 예외를 던져 process가 그
// 오류와 함께 0이 아닌 code로 끝난다.

use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;

/**
 * 인자로 받은 case ID를 선언 순서대로 실행한다. 인자가 없거나 모르는 ID,
 * 중복 ID는 실행 전에 거부한다.
 *
 * @param list<string> $argv
 * @param array<string, Closure(): void> $cases
 */
function runCoverageCases(array $argv, array $cases): void
{
    $requested = array_slice($argv, 1);
    if ($requested === []) {
        throw new RuntimeException('usage: ' . basename($argv[0]) . ' ' . implode(' ', array_keys($cases)));
    }
    if (count(array_unique($requested)) !== count($requested)) {
        throw new RuntimeException('duplicate case ID in ' . implode(' ', $requested));
    }
    foreach ($requested as $id) {
        if (!isset($cases[$id])) {
            throw new RuntimeException("unknown case $id; the cases are " . implode(', ', array_keys($cases)));
        }
    }
    foreach ($requested as $id) {
        $cases[$id]();
        echo "CASE $id PASS\n";
    }
}

/**
 * checker가 고른 database와 DSN이다. 둘 중 하나라도 없으면 실패한다.
 *
 * @return array{string, string}
 */
function coverageDatabase(): array
{
    $driver = getenv('ORM_FEATURE_DATABASE');
    $dsn = getenv('ORM_FEATURE_DSN');
    if (!is_string($driver) || !in_array($driver, ['mysql', 'postgres', 'sqlite'], true) || !is_string($dsn) || $dsn === '') {
        throw new RuntimeException('ORM_FEATURE_DATABASE and ORM_FEATURE_DSN are required');
    }
    return [$driver, $dsn];
}

/** seed된 bench database의 AES와 blind index key로 연결한다(scripts/bench-db.sh). */
function coverageConnect(string $dsn): Db
{
    return \Polyspec\Orm\Tests\Model\connect($dsn, new Config(aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index'));
}

/** 저장소 파일의 JSON을 읽는다. 읽거나 해석할 수 없으면 실패한다. */
function coverageJson(string $path, bool $associative = true): mixed
{
    $text = file_get_contents($path);
    if ($text === false) {
        throw new RuntimeException("cannot read $path");
    }
    return json_decode($text, $associative, 512, JSON_THROW_ON_ERROR);
}

function coverageWant(bool $ok, string $message): void
{
    if (!$ok) {
        throw new RuntimeException($message);
    }
}

/** $fn이 던진 OrmException의 code다. 다른 예외는 그대로 전파하고, 성공하면 'no error'다. */
function coverageCode(Closure $fn): string
{
    try {
        $fn();
    } catch (OrmException $e) {
        return $e->code_;
    }
    return 'no error';
}

/**
 * $body를 실행하고, 성공이든 실패든 $restore로 test가 쓴 행을 되돌린다.
 * 두 단계가 모두 실패하면 두 오류를 함께 보고한다.
 */
function coverageRestoring(Closure $body, Closure $restore): void
{
    try {
        $body();
    } catch (Throwable $failure) {
        try {
            $restore();
        } catch (Throwable $cleanup) {
            throw new RuntimeException('case failed: ' . $failure->getMessage() . '; restore failed: ' . $cleanup->getMessage(), 0, $failure);
        }
        throw $failure;
    }
    $restore();
}

/**
 * 자식 process를 실행해 종료 코드와 stdout, stderr를 돌려준다. 출력은 CASE 출력에
 * 섞이지 않으며, 호출자가 실패 오류에 넣는다.
 *
 * @param list<string> $command
 * @param array<string, string>|null $env
 * @return array{int, string, string}
 */
function coverageProcess(array $command, string $cwd, ?array $env = null): array
{
    $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $cwd, $env);
    if (!is_resource($process)) {
        throw new RuntimeException('cannot start ' . $command[0]);
    }
    // stdout과 stderr를 함께 읽어 한쪽 pipe가 가득 차 자식이 멈추지 않게 한다.
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);
    $out = ['', ''];
    $open = [1 => $pipes[1], 2 => $pipes[2]];
    while ($open !== []) {
        $read = array_values($open);
        $write = null;
        $except = null;
        if (stream_select($read, $write, $except, null) === false) {
            throw new RuntimeException('cannot read the output of ' . $command[0]);
        }
        foreach ($open as $index => $pipe) {
            if (!in_array($pipe, $read, true)) {
                continue;
            }
            $chunk = fread($pipe, 65536);
            if ($chunk === false) {
                throw new RuntimeException('cannot read the output of ' . $command[0]);
            }
            $out[$index - 1] .= $chunk;
            if (feof($pipe)) {
                fclose($pipe);
                unset($open[$index]);
            }
        }
    }
    return [proc_close($process), $out[0], $out[1]];
}
