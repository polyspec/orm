<?php
declare(strict_types=1);

// 확장 orm_dbspec이 등록한 class의 선언과 stubs/orm_dbspec.stub.php의 선언이 같은지 확인한다. 두 선언은
// 같은 이름의 class라 한 process에 함께 load할 수 없으므로 declarations.php를 확장과 함께, 그리고
// 확장 없이 실행한다. stub은 interface 검사(contracts/symbols/php-extension.json)의 inventory다.
//
// Usage: ORM_DBSPEC_EXTENSION=<orm_dbspec library> php clients/php-extension/tests/declarations_test.php

require dirname(__DIR__, 3) . '/tests/testcase.php';

$extension = getenv('ORM_DBSPEC_EXTENSION');
if ($extension === false || $extension === '' || !is_file($extension)) {
    fwrite(STDERR, "ORM_DBSPEC_EXTENSION names no built library of the extension; run make dbspec-php-extension-check, which builds it\n");
    exit(1);
}

/** declarations.php를 $arguments(php 인자)로 실행해 그 JSON을 돌려준다. */
function declarations(array $arguments, string $mode): array
{
    // -n은 php.ini를 읽지 않는다: php.ini가 확장을 load하면 stub과 같은 이름의 class가 이미 있다.
    $command = [PHP_BINARY, '-n', ...$arguments, __DIR__ . '/declarations.php', $mode];
    $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if ($process === false) {
        throw new RuntimeException('cannot start ' . implode(' ', $command));
    }
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($process);
    if ($code !== 0) {
        throw new RuntimeException(implode(' ', $command) . " exited with $code: $err");
    }
    return json_decode($out, true, 512, JSON_THROW_ON_ERROR);
}

$passed = testcase_run('php-extension/declarations', TESTCASE_PROCESS, static function (callable $step) use ($extension): void {
    $native = declarations(['-d', "extension=$extension"], 'extension');
    $stub = declarations([], 'stub');
    $differences = [];
    foreach (array_unique([...array_keys($native), ...array_keys($stub)]) as $key) {
        $want = $stub[$key] ?? '(not declared)';
        $got = $native[$key] ?? '(not declared)';
        if ($want !== $got) {
            $differences[] = "$key\n  stub      $want\n  extension $got";
        }
    }
    if ($differences !== []) {
        throw new RuntimeException("the extension declares other symbols than stubs/orm_dbspec.stub.php:\n" . implode("\n", $differences));
    }
    $step(count($native) . ' declarations equal');
});
exit($passed ? 0 : 1);
