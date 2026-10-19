<?php
declare(strict_types=1);

// The extension orm_dbspec (Polyspec\Orm\Dbspec\Native) against the PHP client for syntax analysis and formatting
// (docs/spec/dbspec.md "Syntax analysis", "Formatting"): the focused cases, the shared cases of tests/dbspec/cases.json and a
// limit stop give the same tokens, positions, diagnostics, emission and formatted text as the PHP client.

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Native\Dbspec as NativeDbspec;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

require_once dirname(__DIR__, 2) . '/php/tests/case_clock.php';
require_once dirname(__DIR__, 2) . '/php/tests/dbspec_cases.php';
require_once dirname(__DIR__, 2) . '/php/tests/dbspec_analysis_cases.php';
require_once dirname(__DIR__, 2) . '/php/tests/dbspec_syntax_vectors.php';

/** The comparable form of an analysis: tokens, positions, diagnostics, emission. */
function analysis_view(object $analysis, string $emitter): array
{
    return [
        'tokens' => array_map(static fn(object $t): array => [$t->line, $t->start, $t->end, $t->class], $analysis->tokens),
        'positions' => $analysis->positions === null ? null : array_map(static fn(object $p): array => [$p->kind, $p->path, $p->line, $p->column], $analysis->positions),
        'diagnostics' => array_map(static fn(object $d): array => [$d->rule, $d->line, $d->column, $d->message], $analysis->diagnostics),
        'emission' => $analysis->document === null ? null : $emitter::emit($analysis->document),
    ];
}

/** Runs one case of the analysis and the format on both implementations and compares them with the PHPUnit assertions. */
function same_analysis(string $id, string $text, array $documents): void
{
    $clock = cpuCaseBegin(2.0);
    $php = Dbspec::analyze($text, $documents);
    $native = NativeDbspec::analyze($text, $documents);
    Assert::assertSame(analysis_view($php, Dbspec::class), analysis_view($native, NativeDbspec::class), "$id analysis: the extension differs from the PHP client");
    $phpFormat = Dbspec::format($text, $documents);
    $nativeFormat = NativeDbspec::format($text, $documents);
    Assert::assertSame($phpFormat->text, $nativeFormat->text, "$id format text: the extension differs from the PHP client");
    Assert::assertSame(array_map(static fn(object $d): array => [$d->rule, $d->line, $d->column, $d->message], $phpFormat->diagnostics), array_map(static fn(object $d): array => [$d->rule, $d->line, $d->column, $d->message], $nativeFormat->diagnostics), "$id format diagnostics: the extension differs from the PHP client");
    cpuCaseEnd("php-extension/analyze/$id", $clock);
}

#[Small]
final class DbspecAnalyzeTest extends TestCase
{
    public static function focusedCases(): iterable
    {
        foreach (dbspec_analysis_focused_cases() as $id => [$text, $want]) {
            yield "focused/$id" => [$text, $want];
        }
    }

    #[DataProvider('focusedCases')]
    public function test_focused(string $text, array $want): void
    {
        $id = (string) $this->dataName();
        same_analysis($id, $text, ['d' => $text]);
        $native = array_map(static fn(object $t): array => [$t->line, $t->start, $t->end, $t->class], NativeDbspec::analyze($text, ['d' => $text])->tokens);
        $this->assertSame($want, $native, "$id tokens: the extension differs from the vector");
    }

    public static function sharedCases(): iterable
    {
        $cases = dbspec_read_cases();
        foreach (['canonical', 'normalize', 'invalid'] as $kind) {
            yield from dbspec_case_sets($kind, $cases[$kind]);
        }
    }

    #[DataProvider('sharedCases')]
    public function test_shared(string $kind, array $case): void
    {
        $texts = dbspec_documents($case['documents'], $case['crlf'] ?? false, $case['mixed'] ?? false);
        same_analysis("$kind/" . $case['id'], $texts[$case['main']], $texts);
    }

    public function test_limit(): void
    {
        $lines = [];
        for ($i = 1; $i <= 4097; $i++) {
            $lines[] = "table t$i {";
            $lines[] = '}';
        }
        $limitText = "dbspec 1 d\n" . implode("\n", $lines) . "\n";
        same_analysis('limit', $limitText, ['d' => $limitText]);
        $this->assertSame([], NativeDbspec::analyze($limitText, ['d' => $limitText])->tokens, 'limit tokens');
    }

    public static function argumentMethods(): iterable
    {
        yield 'analyze' => ['analyze'];
        yield 'format' => ['format'];
    }

    // Argument errors: a document set entry that is not a name and text throws as the PHP client does.
    #[DataProvider('argumentMethods')]
    public function test_argument_error(string $method): void
    {
        $message = [];
        foreach ([Dbspec::class, NativeDbspec::class] as $class) {
            try {
                $class::$method('dbspec 1 d', ['d' => 5]);
                $message[] = 'no exception';
            } catch (InvalidArgumentException $e) {
                $message[] = get_class($e) . ': ' . $e->getMessage();
            }
        }
        $this->assertSame($message[0], $message[1], "$method argument error");
    }

    public static function syntaxCases(): iterable
    {
        return dbspec_syntax_sets(dirname(__DIR__, 3), dbspec_read_cases());
    }

    // The shared syntax vectors: the native tokens of every case of tests/dbspec/syntax.json, exactly.
    #[DataProvider('syntaxCases')]
    public function test_syntax(?array $want, string $text, array $documents): void
    {
        $this->assertNotNull($want, $this->dataName() . ': syntax.json has no tokens for this case');
        $this->assertSame($want, array_map(static fn(object $t): array => [$t->line, $t->start, $t->end, $t->class], NativeDbspec::analyze($text, $documents)->tokens), $this->dataName() . ': tokens differ');
    }

    public function test_syntax_cases_are_produced(): void
    {
        $this->assertSame([], dbspec_syntax_unproduced(dirname(__DIR__, 3), dbspec_read_cases()), 'syntax.json has cases that the inputs do not produce');
    }
}
