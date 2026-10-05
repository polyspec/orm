<?php
declare(strict_types=1);
// Shared dbspec vectors (tests/dbspec/cases.json) through the PHP client.
require __DIR__ . '/autoload.php';
require_once __DIR__ . '/case_clock.php';
require __DIR__ . '/dbspec_cases.php';

$started = caseClockStart();
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
// files case는 Dbspec::readFile에 path를 주어, Dbspec::readBytes에 파일 byte와 case path를
// 이름으로 주어 두 번 읽는다. signature가 없는 byte는 "<name> is not a dbspec document",
// UTF-8이 아닌 byte는 "<name> is not valid UTF-8" diagnostic 하나와 null text를, 나머지는
// 그 byte를 돌려주며 그 text는 parse와 emit에서 바뀌지 않는다.
$fileMessages = ['signature' => ' is not a dbspec document', 'encoding' => ' is not valid UTF-8'];
foreach ($cases['files'] as $case) {
    $path = "$root/tests/dbspec/" . $case['path'];
    $readers = [
        'file' => [$path, static fn(): Orm\Dbspec\ReadResult => Orm\Dbspec\Dbspec::readFile($path)],
        'bytes' => [$case['path'], static fn(): Orm\Dbspec\ReadResult => Orm\Dbspec\Dbspec::readBytes($case['path'], (string) file_get_contents($path))],
    ];
    foreach ($readers as $kind => [$name, $reader]) {
        $id = 'files/' . $case['id'] . '/' . $kind;
        // files case는 file 하나를 읽고 parse하는 계산이며 CPU 한도 2 s를 가진다.
        $clock = cpuCaseBegin($id, 2.0);
        $read = $reader();
        if ($case['errors'] !== []) {
            if ($read->text !== null) {
                throw new RuntimeException("$id: text was returned with diagnostics expected");
            }
            $got = array_map(static fn(Orm\Dbspec\Diagnostic $d): array => ['line' => $d->line, 'column' => $d->column, 'rule' => $d->rule], $read->diagnostics);
            if ($got !== $case['errors']) {
                throw new RuntimeException("$id: diagnostics differ\nwant " . json_encode($case['errors']) . "\ngot  " . json_encode($got));
            }
            foreach ($read->diagnostics as $d) {
                if ($d->message !== $name . ($fileMessages[$d->rule] ?? '')) {
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
        cpuCaseEnd($id, $clock);
        $counts['files'] = ($counts['files'] ?? 0) + 1;
    }
}
// 모든 vector를 합친 CPU 시간을 출력하고, 10 s 기준값을 넘으면 경고한다.
testcase_begin('dbspec_vectors/cpu-total', TESTCASE_COMPUTE);
[$cpuMs, $wallMs] = caseClockElapsed($started);
if ($cpuMs > 10000) {
    testcase_warning(sprintf('dbspec_vectors used %.3f ms of CPU (%.3f ms wall), above its reference of 10 s; machine %s %s, PHP %s', $cpuMs, $wallMs, PHP_OS_FAMILY, php_uname('m'), PHP_VERSION));
}
testcase_step("canonical={$counts['canonical']} normalize={$counts['normalize']} invalid={$counts['invalid']} files={$counts['files']} cpuMs=$cpuMs wallMs=$wallMs");
testcase_end();
