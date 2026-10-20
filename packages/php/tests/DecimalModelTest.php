<?php

declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Decimal;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Tests\Model\Author;

#[Small]
final class DecimalModelTest extends TestCase
{
    /** @return iterable<string, array{array<string, mixed>, array<string, mixed>}> the case and its column of contracts/fixtures/decimal_model.json */
    public static function cases(): iterable
    {
        $fixture = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/decimal_model.json'), true, 512, JSON_THROW_ON_ERROR);
        $columns = [];
        foreach ($fixture['columns'] as $column) {
            $columns[$column['id']] = $column;
        }
        foreach ($fixture['cases'] as $case) {
            yield $case['id'] => [$case, $columns[$case['column']] ?? throw new RuntimeException("unknown column {$case['column']}")];
        }
    }

    /**
     * @param array<string, mixed> $case
     * @param array<string, mixed> $column
     */
    #[DataProvider('cases')]
    public function test_decimal_model(array $case, array $column): void
    {
        try {
            $actual = Decimal::normalize($case['input'], $column['precision'], $column['scale']);
            self::assertArrayNotHasKey('error', $case['expected'], "{$case['id']}: expected an error");
            self::assertSame($case['expected']['value'], $actual);
            $stored = Decimal::scaled($case['input'], $column['precision'], $column['scale']);
            self::assertSame($case['expected']['value'], Decimal::fromScaled($stored, $column['precision'], $column['scale']), "{$case['id']}: SQLite round trip");
        } catch (OrmException $error) {
            self::assertSame($case['expected']['error'] ?? null, $error->code_, "{$case['id']}: unexpected {$error->code_}");
        }
    }

    public function test_generated_decimal_type(): void
    {
        $getter = (new ReflectionMethod(Author::class, 'getPrice'))->getReturnType();
        $setter = (new ReflectionMethod(Author::class, 'setPrice'))->getParameters()[0]->getType();
        self::assertInstanceOf(ReflectionNamedType::class, $getter);
        self::assertInstanceOf(ReflectionNamedType::class, $setter);
        self::assertSame(['string', 'string'], [$getter->getName(), $setter->getName()], 'generated decimal getter and setter must use nullable string');
    }
}
