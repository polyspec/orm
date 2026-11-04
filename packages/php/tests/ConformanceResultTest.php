<?php

// The result helpers of the PHP conformance runner (packages/php/testing/conformance/result_php_helpers.php): a result
// keeps ordered-json numbers and styled states, and a vector failure keeps its cause.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist
// packages/php/tests/ConformanceResultTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DomainException;
use RuntimeException;
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
            'exact' => \Polyspec\OrderedJson\parse('9007199254740993'),
            'styled' => ['kind' => 'value', 'value' => \Polyspec\OrderedJson\parse('{"n":9007199254740993}')],
            'sqlNull' => ['kind' => 'sql-null'],
        ];
        $want = '{"exact":9007199254740993,"styled":{"kind":"value","value":{"n":9007199254740993}},'
            . '"sqlNull":{"kind":"sql-null"}}';
        self::assertSame(
            $want,
            Model::jsonText($result),
            'conformance result changed an ordered-json number or styled state'
        );
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
}
