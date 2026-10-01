<?php
declare(strict_types=1);
// Shared dbspec vectors (tests/dbspec/cases.json) through the PHP client.
require __DIR__ . '/autoload.php';
require __DIR__ . '/dbspec_cases.php';

$started = hrtime(true);
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
$elapsed = (hrtime(true) - $started) / 1e6;
if ($elapsed > 10000) {
    throw new RuntimeException("dbspec_vectors deadline of 10 s exceeded ($elapsed ms)");
}
echo "PASS dbspec_vectors canonical={$counts['canonical']} normalize={$counts['normalize']} invalid={$counts['invalid']} elapsedMs=$elapsed\n";
