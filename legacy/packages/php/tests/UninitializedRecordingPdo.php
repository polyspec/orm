<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;

class UninitializedRecordingPdo extends PDO
{
    /** @var list<string> */
    public array $statements = [];

    // Keep the PDO uninitialized so these tests stay on their no-driver fake.
    public function __construct()
    {
    }

    public function setAttribute(int $attribute, mixed $value): bool
    {
        return true;
    }

    public function exec(string $statement): int|false
    {
        $this->recordStatement($statement);
        $this->afterStatement($statement);
        return 0;
    }

    protected function recordStatement(string $statement): void
    {
        $this->statements[] = $statement;
    }

    protected function afterStatement(string $statement): void
    {
    }
}
