<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal one statement under construction: the value-free IR and the values */
final class Request
{
    public array $ir;
    /** @var list<mixed> */
    public array $params = [];
    /** @var array<string, bool> */
    public array $names = [];
    /** @var array<int, list<array>> relations with their own connection, by parent model */
    public array $external = [];

    public function __construct(string $kind, string $manifestHash)
    {
        $this->ir = ['ir_version' => 1, 'manifest_hash' => $manifestHash, 'kind' => $kind];
    }

    public function param(mixed $v): int
    {
        $this->params[] = $v;
        return count($this->params) - 1;
    }

    /** Rounds a list up to a power of two by repeating its last value. */
    public static function padIn(array $values): array
    {
        $n = 1;
        while ($n < count($values)) {
            $n <<= 1;
        }
        while (count($values) < $n) {
            $values[] = $values[count($values) - 1];
        }
        return $values;
    }

    /** The request with the parameter count, as the engine plans it. */
    public function shape(): array
    {
        return $this->ir + ['n_params' => count($this->params)];
    }
}
