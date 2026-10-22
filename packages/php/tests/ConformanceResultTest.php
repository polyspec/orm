<?php

// The result helpers of the PHP conformance runner (packages/php/testing/conformance/result_php_helpers.php): a result
// keeps ordered-json numbers and styled states, a derived integer is read only from an integral value, and a vector
// failure keeps its cause.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist
// packages/php/tests/ConformanceResultTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Model;

// The check writes and compares a few result values in memory.
#[Small]
final class ConformanceResultTest extends TestCase
{
    public function testConformanceResultPhp(): void
    {
        $result = [
            'exact' => Polyspec\OrderedJson\parse('9007199254740993'),
            'styled' => ['kind' => 'value', 'value' => Polyspec\OrderedJson\parse('{"n":9007199254740993}')],
            'sqlNull' => ['kind' => 'sql-null'],
        ];
        $want = '{"exact":9007199254740993,"styled":{"kind":"value","value":{"n":9007199254740993}},'
            . '"sqlNull":{"kind":"sql-null"}}';
        self::assertSame(
            $want,
            Model::jsonText($result),
            'conformance result changed an ordered-json number or styled state'
        );
        self::assertSame(2, derivedInteger(2), 'valid derived integer changed');
        self::assertSame(2, derivedInteger('2'), 'valid derived integer changed');
        foreach ([null, true, '', 'bad', '2.0', '2.5', 2.5, INF] as $invalid) {
            try {
                derivedInteger($invalid);
                self::fail('invalid derived integer was accepted: ' . var_export($invalid, true));
            } catch (InvalidArgumentException $rejected) {
                self::assertInstanceOf(InvalidArgumentException::class, $rejected, 'the invalid value was rejected');
            }
        }
        $cause = new DomainException('invalid row');
        try {
            executeVector('invalid', static fn(): never => throw $cause);
            self::fail('unexpected vector error was accepted');
        } catch (RuntimeException $error) {
            self::assertSame($cause, $error->getPrevious(), 'unexpected vector error was altered');
            self::assertStringContainsString('invalid', $error->getMessage(), 'unexpected vector error was altered');
        }
        $transactionCalled = false;
        $value = executeVector('write', static fn(): int => 7, static function (callable $task) use (
            &$transactionCalled
        ): int {
            $transactionCalled = true;
            return $task();
        });
        self::assertTrue($transactionCalled, 'write vector did not use its transaction');
        self::assertSame(7, $value, 'write vector did not use its transaction');
    }

    // The vector names of the base expectation file, one case per vector, so every vector is reported by its name.
    /** @return array<string, array{string}> */
    public static function vectorNames(): array
    {
        $names = [];
        foreach (vectorNamesOf(conformanceRoot() . '/tests/conformance/vectors.json') as $name) {
            $names[$name] = [$name];
        }
        return $names;
    }

    #[DataProvider('vectorNames')]
    public function testRunnerDeclaresVector(string $name): void
    {
        self::assertContains($name, declaredVectors(), "the PHP runner does not declare vector $name");
    }

    public function testBindingReportsEveryVector(): void
    {
        $expected = vectorNamesOf(conformanceRoot() . '/tests/conformance/vectors.json');
        $reported = declaredVectors();
        self::assertSame(
            count($expected),
            count(array_intersect($expected, $reported)),
            'the PHP binding reports fewer vectors than the vector file'
        );
        self::assertSame(
            count($expected),
            count($reported),
            'the PHP runner declares vectors that the vector file does not name: ' . implode(
                ', ',
                array_diff($reported, $expected)
            )
        );
    }

    public function testExpectationFilesNameTheSameVectors(): void
    {
        $base = vectorNamesOf(conformanceRoot() . '/tests/conformance/vectors.json');
        foreach (['vectors.postgres.json', 'vectors.sqlite.json'] as $file) {
            self::assertSame(
                $base,
                vectorNamesOf(conformanceRoot() . '/tests/conformance/' . $file),
                "$file names different vectors"
            );
        }
    }
}

function conformanceRoot(): string
{
    return dirname(__DIR__, 3);
}

/**
 * @return list<string> the vector names of a vector file, in order; a file without a nonempty unique list is an error.
 */
function vectorNamesOf(string $path): array
{
    $document = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    $names = array_map(static fn(array $vector): string => $vector['name'], $document['vectors'] ?? []);
    if ($names === [] || count($names) !== count(array_unique($names))) {
        throw new RuntimeException("$path needs a nonempty list of unique vector names");
    }
    return $names;
}

/** @return list<string> the vector names the PHP runner declares, read from its source. */
function declaredVectors(): array
{
    // The names of the top-level vector('<name>', ...) calls of the runner, read from its tokens, so the layout of a
    // call (one line, or its arguments one per line) does not matter.
    $code = (string) file_get_contents(conformanceRoot() . '/packages/php/testing/conformance/runner.php');
    $tokens = array_values(array_filter(
        PhpToken::tokenize($code),
        static fn(PhpToken $token): bool => !$token->is([T_WHITESPACE, T_COMMENT, T_DOC_COMMENT])
    ));
    $names = [];
    foreach ($tokens as $i => $token) {
        $previous = $tokens[$i - 1] ?? null;
        $statementStart = $previous === null || $previous->is([';', '{', '}', T_OPEN_TAG]);
        if (
            $statementStart && $token->is(T_STRING) && $token->text === 'vector'
            && ($tokens[$i + 1] ?? null)?->text === '('
            && ($tokens[$i + 2] ?? null)?->is(T_CONSTANT_ENCAPSED_STRING)
        ) {
            $names[] = substr($tokens[$i + 2]->text, 1, -1);
        }
    }
    return $names;
}
