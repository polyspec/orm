<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Model;

final class NativeModelFixture extends Model
{
    public static function meta(): array
    {
        return [
            'entity' => 'NativeModelFixture',
            'columns' => [
                'id' => ['type' => 'i64', 'codec' => [], 'nullable' => false],
                'label' => ['type' => 'text', 'codec' => [], 'nullable' => true],
                'payload' => ['type' => 'text', 'codec' => ['ordered_json'], 'nullable' => true],
                'amount' => ['type' => 'decimal', 'precision' => 8, 'scale' => 2, 'codec' => [], 'nullable' => true],
                'happened' => ['type' => 'datetime', 'codec' => [], 'nullable' => true],
            ],
        ];
    }

    public function setLabel(mixed $value): static
    {
        return $this->writeColumn('label', $value);
    }

    public function label(): mixed
    {
        return $this->readColumn('label');
    }

    public function setPayload(\Polyspec\Orm\StyledValue $value): static
    {
        return $this->writeColumn('payload', $value);
    }

    public function payload(): \Polyspec\Orm\StyledValue
    {
        return $this->readColumn('payload');
    }

    public function setAmount(mixed $value): static
    {
        return $this->writeColumn('amount', $value);
    }

    public function amount(): mixed
    {
        return $this->readColumn('amount');
    }

    public function setHappened(mixed $value): static
    {
        return $this->writeColumn('happened', $value);
    }

    public function happened(): mixed
    {
        return $this->readColumn('happened');
    }
}
