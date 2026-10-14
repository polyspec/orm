<?php
declare(strict_types=1);
// Shared dbspec vectors (tests/dbspec/cases.json) through the PHP client.
require_once __DIR__ . '/case_clock.php';
require_once __DIR__ . '/dbspec_cases.php';

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Diagnostic;
use Polyspec\Orm\Dbspec\ReadResult;

#[Small]
final class DbspecTest extends TestCase
{
    private static array $started;

    public static function setUpBeforeClass(): void
    {
        self::$started = caseClockStart();
    }

    // 모든 vector를 합친 CPU 시간이 10 s 기준값을 넘으면 경고한다.
    public static function tearDownAfterClass(): void
    {
        [$cpuMs, $wallMs] = caseClockElapsed(self::$started);
        if ($cpuMs > 10000) {
            caseClockWarning(sprintf('dbspec_vectors used %.3f ms of CPU (%.3f ms wall), above its reference of 10 s', $cpuMs, $wallMs));
        }
    }

    /** dbspec_read_cases refuses a missing or unknown section or field of every section, naming it. */
    public static function documentCases(): iterable
    {
        $cases = dbspec_read_cases();
        foreach (['canonical', 'normalize', 'invalid'] as $kind) {
            yield from dbspec_case_sets($kind, $cases[$kind]);
        }
    }

    #[DataProvider('documentCases')]
    public function test_document(string $kind, array $case): void
    {
        dbspec_check_case($kind, $case, 2.0);
    }

    public static function positionCases(): iterable
    {
        foreach (dbspec_read_cases()['positions'] as $case) {
            yield 'positions/' . $case['id'] => [$case];
        }
    }

    #[DataProvider('positionCases')]
    public function test_positions(array $case): void
    {
        dbspec_check_position_case($case, 2.0);
    }

    // files case는 Dbspec::readFile에 path를 주어, Dbspec::readBytes에 파일 byte와 case path를
    // 이름으로 주어 두 번 읽는다. signature가 없는 byte는 "<name> is not a dbspec document",
    // UTF-8이 아닌 byte는 "<name> is not valid UTF-8" diagnostic 하나와 null text를, 나머지는
    // 그 byte를 돌려주며 그 text는 parse와 emit에서 바뀌지 않는다.
    public static function fileCases(): iterable
    {
        foreach (dbspec_read_cases()['files'] as $case) {
            foreach (['file', 'bytes'] as $kind) {
                yield 'files/' . $case['id'] . '/' . $kind => [$case, $kind];
            }
        }
    }

    #[DataProvider('fileCases')]
    public function test_files(array $case, string $kind): void
    {
        $fileMessages = ['signature' => ' is not a dbspec document', 'encoding' => ' is not valid UTF-8'];
        $path = dirname(__DIR__, 3) . '/tests/dbspec/' . $case['path'];
        [$name, $reader] = [
            'file' => [$path, static fn(): ReadResult => Dbspec::readFile($path)],
            'bytes' => [$case['path'], static fn(): ReadResult => Dbspec::readBytes($case['path'], (string) file_get_contents($path))],
        ][$kind];
        $id = 'files/' . $case['id'] . '/' . $kind;
        // files case는 file 하나를 읽고 parse하는 계산이며 CPU 기준값 2 s를 가진다.
        $clock = cpuCaseBegin(2.0);
        $read = $reader();
        if ($case['errors'] !== []) {
            $this->assertNull($read->text, "$id: text was returned with diagnostics expected");
            $got = array_map(static fn(Diagnostic $d): array => ['line' => $d->line, 'column' => $d->column, 'rule' => $d->rule], $read->diagnostics);
            $this->assertSame($case['errors'], $got, "$id: diagnostics differ");
            foreach ($read->diagnostics as $d) {
                $this->assertSame($name . ($fileMessages[$d->rule] ?? ''), $d->message, "$id: message");
            }
        } else {
            $this->assertSame([], $read->diagnostics, "$id: the file bytes were not returned");
            $this->assertSame(file_get_contents($path), $read->text, "$id: the file bytes were not returned");
            $result = Dbspec::parse($read->text, []);
            $this->assertNotNull($result->document, "$id: the file text does not parse");
            $this->assertSame($read->text, Dbspec::emit($result->document), "$id: the file text does not parse and emit unchanged");
        }
        cpuCaseEnd($id, $clock);
    }

    /** The reader of cases.json refuses a missing or an unknown section or field of every section, naming it. */
    public static function strictReaderCases(): iterable
    {
        $cases = dbspec_read_cases();
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
            yield "$location $problem" => [$location, $problem, $change];
        }
    }

    #[DataProvider('strictReaderCases')]
    public function test_strict_reader(string $location, string $problem, Closure $change): void
    {
        $text = (string) file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/cases.json');
        $value = json_decode($text, false, 512, JSON_THROW_ON_ERROR);
        $change($value);
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessageMatches('/^' . preg_quote("tests/dbspec/cases.json: $location $problem", '/') . '$/');
        dbspec_check_cases($value);
    }
}
