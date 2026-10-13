<?php
declare(strict_types=1);
// Shared dbspec vectors (tests/dbspec/cases.json) through the PHP client.
require __DIR__ . '/autoload.php';
require_once __DIR__ . '/case_clock.php';
require __DIR__ . '/dbspec_cases.php';

$started = caseClockStart();
$root = dirname(__DIR__, 3);
// dbspec_read_cases refuses a missing or unknown section or field of every section, naming it.
$cases = dbspec_read_cases();
$counts = [];
foreach (['canonical', 'normalize', 'invalid'] as $kind) {
    $counts[$kind] = dbspec_run_cases($kind, $cases[$kind], 2.0);
}
$counts['positions'] = dbspec_run_position_cases($cases['positions'], 2.0);
// files case는 Dbspec::readFile에 path를 주어, Dbspec::readBytes에 파일 byte와 case path를
// 이름으로 주어 두 번 읽는다. signature가 없는 byte는 "<name> is not a dbspec document",
// UTF-8이 아닌 byte는 "<name> is not valid UTF-8" diagnostic 하나와 null text를, 나머지는
// 그 byte를 돌려주며 그 text는 parse와 emit에서 바뀌지 않는다.
$fileMessages = ['signature' => ' is not a dbspec document', 'encoding' => ' is not valid UTF-8'];
foreach ($cases['files'] as $case) {
    $path = "$root/tests/dbspec/" . $case['path'];
    $readers = [
        'file' => [$path, static fn(): Polyspec\Orm\Dbspec\ReadResult => Polyspec\Orm\Dbspec\Dbspec::readFile($path)],
        'bytes' => [$case['path'], static fn(): Polyspec\Orm\Dbspec\ReadResult => Polyspec\Orm\Dbspec\Dbspec::readBytes($case['path'], (string) file_get_contents($path))],
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
            $got = array_map(static fn(Polyspec\Orm\Dbspec\Diagnostic $d): array => ['line' => $d->line, 'column' => $d->column, 'rule' => $d->rule], $read->diagnostics);
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
            $result = Polyspec\Orm\Dbspec\Dbspec::parse($read->text, []);
            if ($result->document === null || Polyspec\Orm\Dbspec\Dbspec::emit($result->document) !== $read->text) {
                throw new RuntimeException("$id: the file text does not parse and emit unchanged");
            }
        }
        cpuCaseEnd($id, $clock);
        $counts['files'] = ($counts['files'] ?? 0) + 1;
    }
}
// The reader of cases.json refuses a missing or an unknown section or field of every section, naming it.
testcase_begin('dbspec_vectors/strict-reader', TESTCASE_COMPUTE);
$text = (string) file_get_contents("$root/tests/dbspec/cases.json");
$manifest = array_key_first(array_filter($cases['sets'], static fn(array $c): bool => array_key_exists('manifest', $c)));
$mutations = [
    ['note', 'is missing', static function (stdClass $v): void { unset($v->note); }],
    ['extra', 'is not a known field', static function (stdClass $v): void { $v->extra = []; }],
    ['canonical[0].extra', 'is not a known field', static function (stdClass $v): void { $v->canonical[0]->extra = true; }],
    ['normalize[0].canonical', 'is missing', static function (stdClass $v): void { unset($v->normalize[0]->canonical); }],
    ['invalid[0].errors[0].extra', 'is not a known field', static function (stdClass $v): void { $v->invalid[0]->errors[0]->extra = 1; }],
    ['hashes[0].extra', 'is not a known field', static function (stdClass $v): void { $v->hashes[0]->extra = true; }],
    ['sets[0].extra', 'is not a known field', static function (stdClass $v): void { $v->sets[0]->extra = true; }],
    ["sets[$manifest].manifest.extra", 'is not a known field', static function (stdClass $v) use ($manifest): void { $v->sets[$manifest]->manifest->extra = []; }],
    ['files[0].errors', 'is missing', static function (stdClass $v): void { unset($v->files[0]->errors); }],
    ['positions[0].positions[0].extra', 'is not a known field', static function (stdClass $v): void { $v->positions[0]->positions[0]->extra = 1; }],
    ['positions[0].positions[0].line', 'is not an integer', static function (stdClass $v): void { $v->positions[0]->positions[0]->line = true; }],
];
foreach ($mutations as [$location, $problem, $change]) {
    $value = json_decode($text, false, 512, JSON_THROW_ON_ERROR);
    $change($value);
    $want = "tests/dbspec/cases.json: $location $problem";
    $got = null;
    try {
        dbspec_check_cases($value);
    } catch (RuntimeException $e) {
        $got = $e->getMessage();
    }
    if ($got !== $want) {
        throw new RuntimeException("$location: the reader gave " . json_encode($got) . ", want \"$want\"");
    }
}
testcase_step(count($mutations) . ' refused');
testcase_end();
// 모든 vector를 합친 CPU 시간을 출력하고, 10 s 기준값을 넘으면 경고한다.
testcase_begin('dbspec_vectors/cpu-total', TESTCASE_COMPUTE);
[$cpuMs, $wallMs] = caseClockElapsed($started);
if ($cpuMs > 10000) {
    testcase_warning(sprintf('dbspec_vectors used %.3f ms of CPU (%.3f ms wall), above its reference of 10 s; machine %s %s, PHP %s', $cpuMs, $wallMs, PHP_OS_FAMILY, php_uname('m'), PHP_VERSION));
}
testcase_step("canonical={$counts['canonical']} normalize={$counts['normalize']} invalid={$counts['invalid']} files={$counts['files']} cpuMs=$cpuMs wallMs=$wallMs");
testcase_end();
