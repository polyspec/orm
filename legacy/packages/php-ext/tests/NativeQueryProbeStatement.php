<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PDOStatement;

/** A statement that records the exact SQL and parameters before SQLite executes them. */
final class NativeQueryProbeStatement extends PDOStatement
{
    /** @var array<int|string, mixed> */
    private array $bound = [];

    protected function __construct(private readonly NativeQueryProbePdo $pdo)
    {
    }

    public function bindValue(string|int $param, mixed $value, int $type = \PDO::PARAM_STR): bool
    {
        $this->bound[$param] = $value;
        return parent::bindValue($param, $value, $type);
    }

    /** @param list<mixed>|null $params */
    public function execute(?array $params = null): bool
    {
        $values = $params ?? $this->bound;
        if ($params === null) {
            ksort($values);
        }
        $this->pdo->executions[] = ['sql' => $this->queryString, 'params' => array_values($values)];
        return parent::execute($params);
    }
}
