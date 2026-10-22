<?php

declare(strict_types=1);

/**
 * A SQLite connection that injects an error into the chosen statement and replaces the chosen query with another query.
 * The replaced query runs without the parameters of the original query.
 */
final class FailingPdo extends PDO
{
    /**
     * @param array<string, PDOException> $fail the error exec throws for each statement
     * @param array<string, string> $replace the query sent instead, for each query
     * @param list<string> $failClose the queries whose close fails
     */
    public function __construct(
        string $path,
        private readonly array $fail,
        private readonly array $replace,
        array $failClose
    ) {
        parent::__construct("sqlite:$path", null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_STATEMENT_CLASS => [FailingStatement::class, [array_values($replace), $failClose]],
        ]);
    }

    public function exec(string $statement): int|false
    {
        if (isset($this->fail[$statement])) {
            throw $this->fail[$statement];
        }
        return parent::exec($statement);
    }

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        return parent::query($this->replace[$query] ?? $query, $fetchMode, ...$fetchModeArgs);
    }

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        return parent::prepare($this->replace[$query] ?? $query, $options);
    }
}
