<?php

declare(strict_types=1);

/** The statement that runs the replaced query without parameters, and whose result close fails for the chosen query. */
final class FailingStatement extends PDOStatement
{
    /**
     * @param list<string> $replacements the queries that were sent instead
     * @param list<string> $failClose
     */
    protected function __construct(private readonly array $replacements, private readonly array $failClose)
    {
    }

    public function execute(?array $params = null): bool
    {
        return parent::execute(in_array($this->queryString, $this->replacements, true) ? null : $params);
    }

    public function closeCursor(): bool
    {
        return in_array($this->queryString, $this->failClose, true) ? false : parent::closeCursor();
    }
}
