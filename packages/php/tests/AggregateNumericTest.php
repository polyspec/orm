<?php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;

#[Small]
final class AggregateNumericTest extends TestCase
{
    /** @return iterable<string, array{array<string, mixed>}> for each case in contracts/fixtures/aggregate_numeric.json */
    public static function cases(): iterable
    {
        $fixture = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/aggregate_numeric.json'), true, 512, JSON_THROW_ON_ERROR);
        foreach ($fixture['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('cases')]
    public function test_aggregate_numeric(array $case): void
    {
        $convert = new ReflectionMethod(Model::class, 'aggregateNumber');
        $input = match ($case['input_type']) {
            'integer_text' => (int) $case['input'],
            'decimal_text' => $case['input'],
            'null' => null,
            default => throw new RuntimeException("unknown input type {$case['input_type']}"),
        };
        try {
            $number = $convert->invoke(null, $input);
        } catch (OrmException $error) {
            self::assertSame($case['expected']['error'] ?? null, $error->code_, "{$case['id']}: unexpected {$error->code_}");
            return;
        }
        self::assertArrayNotHasKey('error', $case['expected'], "{$case['id']}: expected an error, got a value");
        self::assertSame($case['expected']['bits'], bin2hex(pack('E', $number)));
    }
}
