<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The strict reader of the shared dbspec vectors (tests/dbspec/cases.json, hashes and sets). The canonical, normalize,
// invalid, positions and files cases are recipes (tests/dbspec/*.json), checked by their *RecipeTest classes.

use Closure;
use RuntimeException;
use stdClass;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class DbspecTest extends TestCase
{
    use DbspecTimedCases;

    protected static function timingName(): string
    {
        return 'dbspec_vectors';
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
