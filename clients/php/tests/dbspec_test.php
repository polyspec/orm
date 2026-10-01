<?php
declare(strict_types=1);
// Shared dbspec vectors (tests/dbspec/cases.json) through the PHP client.
require __DIR__ . '/autoload.php';
require_once __DIR__ . '/case_clock.php';
require __DIR__ . '/dbspec_cases.php';

$started = caseClockStart();
echo "RUN dbspec_vectors\n";
$root = dirname(__DIR__, 3);
$cases = json_decode(file_get_contents("$root/tests/dbspec/cases.json"), true, 512, JSON_THROW_ON_ERROR);
if ($cases['version'] !== 1) {
    throw new RuntimeException('Unknown dbspec vector version');
}
$counts = [];
foreach (['canonical', 'normalize', 'invalid'] as $kind) {
    if (!isset($cases[$kind]) || $cases[$kind] === []) {
        throw new RuntimeException("Missing $kind vectors");
    }
    $counts[$kind] = dbspec_run_cases($kind, $cases[$kind], 2.0);
}
[$cpuMs, $wallMs] = caseClockElapsed($started);
if ($cpuMs > 10000) {
    throw new RuntimeException("dbspec_vectors CPU deadline of 10 s exceeded ($cpuMs ms CPU, $wallMs ms wall)");
}
echo "PASS dbspec_vectors canonical={$counts['canonical']} normalize={$counts['normalize']} invalid={$counts['invalid']} cpuMs=$cpuMs wallMs=$wallMs\n";
