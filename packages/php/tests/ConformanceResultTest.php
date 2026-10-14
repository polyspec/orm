<?php
// The result helpers of the PHP conformance runner (tests/conformance/result_php_helpers.php): a result keeps ordered-json
// numbers and styled states, a derived integer is read only from an integral value, and a vector failure keeps its cause.
// Usage: packages/php/vendor/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/ConformanceResultTest.php
declare(strict_types=1);

require_once dirname(__DIR__, 3) . '/tests/conformance/result_php_helpers.php';

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
}
