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
if (!isset($cases['files']) || $cases['files'] === []) {
    throw new RuntimeException('Missing files vectors');
}
// files case는 Dbspec::readFile로 읽는다. signature가 없는 파일은 "<path> is not a dbspec
// document" diagnostic 하나와 null text를, 나머지 파일은 그 byte를 돌려주며 그 text는
// parse와 emit에서 바뀌지 않는다.
foreach ($cases['files'] as $case) {
    $id = 'files/' . $case['id'];
    echo "RUN $id\n";
    $caseStarted = caseClockStart();
    $path = "$root/tests/dbspec/" . $case['path'];
    $read = Orm\Dbspec\Dbspec::readFile($path);
    if ($case['errors'] !== []) {
        if ($read->text !== null) {
            throw new RuntimeException("$id: text was returned with diagnostics expected");
        }
        $got = array_map(static fn(Orm\Dbspec\Diagnostic $d): array => ['line' => $d->line, 'column' => $d->column, 'rule' => $d->rule], $read->diagnostics);
        if ($got !== $case['errors']) {
            throw new RuntimeException("$id: diagnostics differ\nwant " . json_encode($case['errors']) . "\ngot  " . json_encode($got));
        }
        foreach ($read->diagnostics as $d) {
            if ($d->message !== "$path is not a dbspec document") {
                throw new RuntimeException("$id: message is {$d->message}");
            }
        }
    } else {
        if ($read->diagnostics !== [] || $read->text !== file_get_contents($path)) {
            throw new RuntimeException("$id: the file bytes were not returned");
        }
        $result = Orm\Dbspec\Dbspec::parse($read->text, []);
        if ($result->document === null || Orm\Dbspec\Dbspec::emit($result->document) !== $read->text) {
            throw new RuntimeException("$id: the file text does not parse and emit unchanged");
        }
    }
    [$caseCpuMs, $caseWallMs] = caseClockElapsed($caseStarted);
    echo "PASS $id cpuMs=$caseCpuMs wallMs=$caseWallMs\n";
    $counts['files'] = ($counts['files'] ?? 0) + 1;
}
[$cpuMs, $wallMs] = caseClockElapsed($started);
if ($cpuMs > 10000) {
    throw new RuntimeException("dbspec_vectors CPU deadline of 10 s exceeded ($cpuMs ms CPU, $wallMs ms wall)");
}
echo "PASS dbspec_vectors canonical={$counts['canonical']} normalize={$counts['normalize']} invalid={$counts['invalid']} files={$counts['files']} cpuMs=$cpuMs wallMs=$wallMs\n";
