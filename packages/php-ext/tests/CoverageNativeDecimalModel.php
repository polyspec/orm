<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Model;

final class CoverageNativeDecimalModel extends Model
{
    public static int $precision = 1;
    public static int $scale = 0;

    public static function meta(): array
    {
        return [
            'entity' => 'coverage_native_decimal',
            'columns' => [
                'amount' => [
                    'type' => 'decimal',
                    'precision' => self::$precision,
                    'scale' => self::$scale,
                    'codec' => [],
                    'nullable' => true,
                ],
            ],
        ];
    }

    public function setAmount(mixed $value): static
    {
        return $this->writeColumn('amount', $value);
    }

    public function getAmount(): mixed
    {
        return $this->readColumn('amount');
    }
}
