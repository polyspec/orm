<?php

// The result helpers of the PHP conformance runner (packages/php/testing/conformance/result_php_helpers.php): a result keeps ordered-json
// numbers and styled states, a derived integer is read only from an integral value, and a vector failure keeps its cause.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/ConformanceResultTest.php
declare(strict_types=1);

require_once dirname(__DIR__) . '/testing/conformance/result_php_helpers.php';

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Model;

// The check writes and compares a few result values in memory.
#[Small]
final class ConformanceResultTest extends TestCase
{
    public function test_conformance_result_php(): void
    {
        $result = [
            'exact' => Polyspec\OrderedJson\parse('9007199254740993'),
            'styled' => ['kind' => 'value', 'value' => Polyspec\OrderedJson\parse('{"n":9007199254740993}')],
            'sqlNull' => ['kind' => 'sql-null'],
        ];
        $want = '{"exact":9007199254740993,"styled":{"kind":"value","value":{"n":9007199254740993}},"sqlNull":{"kind":"sql-null"}}';
        self::assertSame($want, Model::jsonText($result), 'conformance result changed an ordered-json number or styled state');
        self::assertSame(2, derivedInteger(2), 'valid derived integer changed');
        self::assertSame(2, derivedInteger('2'), 'valid derived integer changed');
        foreach ([null, true, '', 'bad', '2.0', '2.5', 2.5, INF] as $invalid) {
            try {
                derivedInteger($invalid);
                self::fail('invalid derived integer was accepted: ' . var_export($invalid, true));
            } catch (InvalidArgumentException) {
                // The invalid value was rejected.
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
        $value = executeVector('write', static fn(): int => 7, static function (callable $task) use (&$transactionCalled): int {
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
    public function test_runner_declares_vector(string $name): void
    {
        self::assertContains($name, declaredVectors(), "the PHP runner does not declare vector $name");
    }

    public function test_binding_reports_every_vector(): void
    {
        $expected = vectorNamesOf(conformanceRoot() . '/tests/conformance/vectors.json');
        $reported = declaredVectors();
        self::assertSame(count($expected), count(array_intersect($expected, $reported)), 'the PHP binding reports fewer vectors than the vector file');
        self::assertSame(count($expected), count($reported), 'the PHP runner declares vectors that the vector file does not name: ' . implode(', ', array_diff($reported, $expected)));
    }

    public function test_expectation_files_name_the_same_vectors(): void
    {
        $base = vectorNamesOf(conformanceRoot() . '/tests/conformance/vectors.json');
        foreach (['vectors.postgres.json', 'vectors.sqlite.json'] as $file) {
            self::assertSame($base, vectorNamesOf(conformanceRoot() . '/tests/conformance/' . $file), "$file names different vectors");
        }
    }
}

function conformanceRoot(): string
{
    return dirname(__DIR__, 3);
}

/** @return list<string> the vector names of a vector file, in order; a file without a nonempty unique list is an error. */
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
    preg_match_all("/^vector\\('([a-z0-9_]+)',/m", (string) file_get_contents(conformanceRoot() . '/packages/php/testing/conformance/runner.php'), $matches);
    return $matches[1];
}
