<?php

declare(strict_types=1);

// Shared dbspec vectors (tests/dbspec/cases.json) through the PHP client.

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

    // Warns if the CPU time of all vectors together exceeds the 10 s baseline.
    public static function tearDownAfterClass(): void
    {
        [$cpuMs, $wallMs] = caseClockElapsed(self::$started);
        if ($cpuMs > 10000) {
            caseClockWarning(
                sprintf(
                    'dbspec_vectors used %.3f ms of CPU (%.3f ms wall), above its reference of 10 s',
                    $cpuMs,
                    $wallMs
                )
            );
        }
    }

    /** The canonical cases of tests/dbspec/cases.json, one data set per case id. */
    public static function canonicalCases(): iterable
    {
        return dbspec_case_ids('canonical', dbspec_read_cases()['canonical']);
    }

    /** The normalize cases of tests/dbspec/cases.json, one data set per case id. */
    public static function normalizeCases(): iterable
    {
        return dbspec_case_ids('normalize', dbspec_read_cases()['normalize']);
    }

    /** The invalid cases of tests/dbspec/cases.json, one data set per case id. */
    public static function invalidCases(): iterable
    {
        return dbspec_case_ids('invalid', dbspec_read_cases()['invalid']);
    }

    #[DataProvider('canonicalCases')]
    public function testCanonical(string $kind, array $case): void
    {
        dbspec_check_case($kind, $case, 2.0);
    }

    #[DataProvider('normalizeCases')]
    public function testNormalize(string $kind, array $case): void
    {
        dbspec_check_case($kind, $case, 2.0);
    }

    #[DataProvider('invalidCases')]
    public function testInvalid(string $kind, array $case): void
    {
        dbspec_check_case($kind, $case, 2.0);
    }

    public static function positionCases(): iterable
    {
        foreach (dbspec_read_cases()['positions'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    #[DataProvider('positionCases')]
    public function testPositions(array $case): void
    {
        dbspec_check_position_case($case, 2.0);
    }

    // The files case passes a path to Dbspec::readFile, and passes the file bytes and the case path
    // by name to Dbspec::readBytes, and reads twice. Bytes without a signature give "<name> is not a dbspec document",
    // bytes that are not UTF-8 give one "<name> is not valid UTF-8" diagnostic and a null text, and the rest
    // return those bytes, and that text does not change in parse and emit.
    public static function fileCases(): iterable
    {
        foreach (dbspec_read_cases()['files'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    #[DataProvider('fileCases')]
    public function testFiles(array $case): void
    {
        foreach (['file', 'bytes'] as $kind) {
            $this->checkFile($case, $kind);
        }
    }

    private function checkFile(array $case, string $kind): void
    {
        $fileMessages = ['signature' => ' is not a dbspec document', 'encoding' => ' is not valid UTF-8'];
        $path = dirname(__DIR__, 3) . '/tests/dbspec/' . $case['path'];
        [$name, $reader] = [
            'file' => [$path, static fn(): ReadResult => Dbspec::readFile($path)],
            'bytes' => [
                $case['path'],
                static fn(): ReadResult => Dbspec::readBytes($case['path'], (string) file_get_contents($path))
            ],
        ][$kind];
        $id = 'files/' . $case['id'] . '/' . $kind;
        // The files case is a computation that reads and parses one file, and has a CPU baseline of 2 s.
        $clock = cpuCaseBegin(2.0);
        $read = $reader();
        if ($case['errors'] !== []) {
            $this->assertNull($read->text, "$id: text was returned with diagnostics expected");
            $got = array_map(
                static fn(Diagnostic $d): array => ['line' => $d->line, 'column' => $d->column, 'rule' => $d->rule],
                $read->diagnostics
            );
            $this->assertSame($case['errors'], $got, "$id: diagnostics differ");
            foreach ($read->diagnostics as $d) {
                $this->assertSame($name . ($fileMessages[$d->rule] ?? ''), $d->message, "$id: message");
            }
        } else {
            $this->assertSame([], $read->diagnostics, "$id: the file bytes were not returned");
            $this->assertSame(file_get_contents($path), $read->text, "$id: the file bytes were not returned");
            $result = Dbspec::parse($read->text, []);
            $this->assertNotNull($result->document, "$id: the file text does not parse");
            $this->assertSame(
                $read->text,
                Dbspec::emit($result->document),
                "$id: the file text does not parse and emit unchanged"
            );
        }
        cpuCaseEnd($id, $clock);
    }

    /** The reader of cases.json refuses a missing or an unknown section or field of every section, naming it. */
    public static function strictReaderCases(): iterable
    {
        $cases = dbspec_read_cases();
        $manifest = array_key_first(
            array_filter($cases['sets'], static fn(array $c): bool => array_key_exists('manifest', $c))
        );
        $mutations = [
            ['note', 'is missing', static function (stdClass $v): void {
                unset($v->note);
            }],
            ['extra', 'is not a known field', static function (stdClass $v): void {
                $v->extra = [];
            }],
            ['canonical[0].extra', 'is not a known field', static function (stdClass $v): void {
                $v->canonical[0]->extra = true;
            }],
            ['normalize[0].canonical', 'is missing', static function (stdClass $v): void {
                unset($v->normalize[0]->canonical);
            }],
            ['invalid[0].errors[0].extra', 'is not a known field', static function (stdClass $v): void {
                $v->invalid[0]->errors[0]->extra = 1;
            }],
            ['hashes[0].extra', 'is not a known field', static function (stdClass $v): void {
                $v->hashes[0]->extra = true;
            }],
            ['sets[0].extra', 'is not a known field', static function (stdClass $v): void {
                $v->sets[0]->extra = true;
            }],
            ["sets[$manifest].manifest.extra", 'is not a known field', static function (
                stdClass $v
            ) use ($manifest): void {
                $v->sets[$manifest]->manifest->extra = [];
            }],
            ['files[0].errors', 'is missing', static function (stdClass $v): void {
                unset($v->files[0]->errors);
            }],
            ['positions[0].positions[0].extra', 'is not a known field', static function (stdClass $v): void {
                $v->positions[0]->positions[0]->extra = 1;
            }],
            ['positions[0].positions[0].line', 'is not an integer', static function (stdClass $v): void {
                $v->positions[0]->positions[0]->line = true;
            }],
        ];
        foreach ($mutations as [$location, $problem, $change]) {
            yield "$location $problem" => [$location, $problem, $change];
        }
    }

    #[DataProvider('strictReaderCases')]
    public function testStrictReader(string $location, string $problem, Closure $change): void
    {
        $text = (string) file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/cases.json');
        $value = json_decode($text, false, 512, JSON_THROW_ON_ERROR);
        $change($value);
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessageMatches(
            '/^' . preg_quote("tests/dbspec/cases.json: $location $problem", '/') . '$/'
        );
        dbspec_check_cases($value);
    }
}
