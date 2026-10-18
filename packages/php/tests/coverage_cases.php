<?php
declare(strict_types=1);
// packages/php/tests/Coverage*Test.php가 함께 쓰는 feature coverage helper다(scripts/features/coverage.mts가
// 그 test method를 PHPUnit으로 실행한다).

use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;

/**
 * The coverage items of a test file from the feature resolver (scripts/features/coverage.mts --items, the form the Python
 * readers use): one [database, dsn] for each database the manifest lists for the file. A DSN variable that is unset fails
 * with its name, from the resolver.
 *
 * @return list<array{string, ?string}>
 */
function coverageItemsOf(string $testFile): array
{
    $root = realpath(dirname(__DIR__, 3));
    $relative = substr((string) realpath($testFile), strlen((string) $root) + 1);
    $process = proc_open(['node', "$root/scripts/features/coverage.mts", '--items', $relative], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $root);
    if (!is_resource($process)) {
        throw new RuntimeException("cannot run the coverage resolver for $relative");
    }
    $text = stream_get_contents($pipes[1]);
    $errors = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $status = proc_close($process);
    if ($status !== 0) {
        throw new RuntimeException("coverage items of $relative: " . trim((string) $errors));
    }
    $items = [];
    foreach (json_decode((string) $text, true, 512, JSON_THROW_ON_ERROR) as $item) {
        $items[] = [$item['database'], $item['dsn'] ?? null];
    }
    return $items;
}

/** The item that the running test method selected; a test method selects each item of the resolver in turn. */
function selectCoverageItem(array $item): void
{
    $GLOBALS['orm_coverage_item'] = $item;
}

/** @return array{string, ?string} the item the running test method selected */
function coverageItem(): array
{
    $item = $GLOBALS['orm_coverage_item'] ?? null;
    if (!is_array($item)) {
        throw new RuntimeException('no coverage item is selected; a test method runs each item of coverageItemsOf(__FILE__)');
    }
    return $item;
}

require_once __DIR__ . '/required_dsn.php';

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
 * 자식 process를 실행해 종료 코드와 stdout, stderr를 돌려준다. 출력은 test 출력에
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
