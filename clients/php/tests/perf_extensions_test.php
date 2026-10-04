<?php
// The hot-path gate refuses a PHP that loads a debugger or coverage driver.
declare(strict_types=1);

require __DIR__ . '/perf_extensions.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

$cases = new TestCases();
$cases->run('perf_extensions/refused', TESTCASE_COMPUTE, function (): void {
    foreach ([
        [[], []],
        [['xdebug'], ['xdebug']],
        [['pcov'], ['pcov']],
        [['xdebug', 'pcov', 'apcu'], ['xdebug', 'pcov']],
        [['apcu', 'opcache'], []],
    ] as [$loaded, $refused]) {
        $got = perfGateRefusedExtensions(fn (string $name): bool => in_array($name, $loaded, true));
        if ($got !== $refused) {
            throw new RuntimeException('loaded ' . json_encode($loaded) . ' refused ' . json_encode($got) . ', want ' . json_encode($refused));
        }
    }
});
$cases->run('perf_extensions/this PHP', TESTCASE_COMPUTE, function (): void {
    $got = perfGateRefusedExtensions(fn (string $name): bool => extension_loaded($name));
    $want = array_values(array_filter(['xdebug', 'pcov'], 'extension_loaded'));
    if ($got !== $want) {
        throw new RuntimeException('refused ' . json_encode($got) . ', want ' . json_encode($want));
    }
});
$cases->finish();
