<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/** A selected styled column value, including the SQL NULL state. */
final readonly class StyledValue implements \JsonSerializable
{
    private function __construct(public string $kind, private mixed $payload = null) {}

    public static function sqlNull(): self
    {
        return new self('sql-null');
    }

    public static function value(mixed $value): self
    {
        return new self('value', $value);
    }

    public function payload(): mixed
    {
        if ($this->kind === 'sql-null') {
            throw new OrmException(Code::CODEC_DECODE, 'SQL NULL has no styled value');
        }
        return $this->payload;
    }

    public function jsonSerialize(): array
    {
        return $this->kind === 'sql-null'
            ? ['kind' => 'sql-null']
            : ['kind' => 'value', 'value' => $this->payload];
    }
}
