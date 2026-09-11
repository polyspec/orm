<?php
declare(strict_types=1);

namespace Orm;

/** Execution state belongs to a query or loaded row, outside its IR. */
trait ConnectionBinding
{
    private ?Binding $binding = null;

    public function using(Db|\PDO $db): static
    {
        $this->binding = new Binding($db instanceof Db ? $db : new Db($db, Orm::config()->driver));
        return $this;
    }

    public function __invoke(Db|\PDO $db): static { return $this->using($db); }

    protected function terminalDb(): Db
    {
        return ($this->binding ?? new Binding())->resolve();
    }

    protected function boundDb(): ?Db { return $this->binding?->resolve(); }

    protected function terminalArity(int $actual, int $expected = 0): void
    {
        if ($actual !== $expected) {
            throw new OrmException(Code::IR_INVALID, "terminal expects $expected value arguments");
        }
    }
}
