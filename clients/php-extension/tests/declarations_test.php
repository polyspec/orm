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
// 확장은 PHP client의 @internal이 아닌 class마다 같은 public 선언(이름, 부모, 상수, property의 순서와 type, 메서드)을 가지고,
// 그 밖의 class는 stub이 @internal로 적은 것뿐이다.
$matched = testcase_run('php-extension/client', TESTCASE_PROCESS, static function (callable $step) use ($extension): void {
    $native = declarations(['-d', "extension=$extension"], 'extension');
    $client = declarations([], 'client');
    $differences = [];
    $classes = [];
    foreach ($client as $key => $want) {
        $classes[explode('::', $key)[0]] = true;
        $got = $native[$key] ?? '(not declared)';
        if ($want !== $got) {
            $differences[] = "$key\n  client    $want\n  extension $got";
        }
    }
    // property 순서: 생성자와 객체 graph가 PHP client의 순서를 따른다.
    $order = static fn(array $declarations): array => array_values(array_filter(array_keys($declarations), static fn(string $k): bool => str_contains($k, '::$')));
    $clientOrder = $order($client);
    $nativeOrder = array_values(array_filter($order($native), static fn(string $k): bool => isset($classes[explode('::', $k)[0]]) && str_starts_with($native[$k], 'public')));
    if ($clientOrder !== $nativeOrder) {
        $differences[] = 'public properties in another order: client ' . implode(', ', $clientOrder) . '; extension ' . implode(', ', $nativeOrder);
    }
    preg_match_all('/@internal\n \*\/\n(?:final |abstract )?(?:readonly )?class (\w+)/', file_get_contents(dirname(__DIR__) . '/stubs/orm_dbspec.stub.php'), $internal);
    foreach (array_keys($native) as $key) {
        $class = explode('::', $key)[0];
        if (!isset($classes[$class]) && !in_array(substr($class, strlen('Orm\\Dbspec\\Native\\')), $internal[1], true)) {
            $differences[] = "$class is neither a class of the PHP client nor @internal in the stub";
            $classes[$class] = true;
        }
    }
    if ($differences !== []) {
        throw new RuntimeException("the extension differs from the PHP client's dbspec classes:\n" . implode("\n", $differences));
    }
    $step(count($client) . ' public declarations of ' . count($classes) . ' classes equal the PHP client\'s');
});
// PIE는 composer.json의 php-ext로 확장을 build한다: 그 이름은 load한 확장의 이름이고 build-path에 config.m4가 있다.
$packaged = testcase_run('php-extension/package', TESTCASE_PROCESS, static function (callable $step): void {
    $package = json_decode(file_get_contents(dirname(__DIR__) . '/composer.json'), true, 512, JSON_THROW_ON_ERROR);
    $name = $package['php-ext']['extension-name'] ?? null;
    if ($package['type'] !== 'php-ext' || $name !== 'orm_dbspec') {
        throw new RuntimeException("clients/php-extension/composer.json declares the extension " . json_encode($name) . " of type " . json_encode($package['type']) . ", not orm_dbspec of type php-ext");
    }
    $config = dirname(__DIR__) . '/' . ($package['php-ext']['build-path'] ?? '') . '/config.m4';
    if (!is_file($config) || !str_contains(file_get_contents($config), "PHP_NEW_EXTENSION([$name]")) {
        throw new RuntimeException("the build-path of clients/php-extension/composer.json has no config.m4 that builds $name");
    }
    $step("$name builds from {$package['php-ext']['build-path']}");
});
// 확장의 test 가운데 PHP client test와 같은 case를 따르는 것은 그 test와 본문이 같다: 그 file의 header(설명, require와
// use) 뒤 첫 `const` 선언부터 끝까지가 PHP client test의 같은 부분과 같다.
$mirrored = testcase_run('php-extension/mirrors', TESTCASE_PROCESS, static function (callable $step): void {
    $root = dirname(__DIR__, 3);
    $mirrors = ['dbspec_plan_test.php', 'dbspec_mermaid_test.php', 'dbspec_introspect_test.php', 'dbspec_apply_cleanup_test.php', 'dbspec_apply_test.php'];
    foreach ($mirrors as $file) {
        $body = static function (string $path): string {
            $text = file_get_contents($path);
            $at = strpos($text, "\nconst ");
            if ($at === false) {
                throw new RuntimeException("$path has no const declaration, where the shared body starts");
            }
            return substr($text, $at);
        };
        if ($body("$root/clients/php-extension/tests/$file") !== $body("$root/clients/php/tests/$file")) {
            throw new RuntimeException("clients/php-extension/tests/$file differs from clients/php/tests/$file after its header; change both tests together");
        }
    }
    $step(count($mirrors) . ' tests follow the PHP client tests');
});
exit($passed && $matched && $packaged && $mirrored ? 0 : 1);
