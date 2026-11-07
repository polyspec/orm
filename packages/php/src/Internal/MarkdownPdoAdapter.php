<?php

declare(strict_types=1);

namespace Polyspec\Orm\Internal;

use PDO;
use PDOStatement;
use Polyspec\Orm\Code;
use Polyspec\Orm\MarkdownSession;
use Polyspec\Orm\OrmException;

/**
 * A markdown connection as the PDO handle of a SQLite connection: a flowmark server runs the statements of SQL in
 * SQLite's dialect on the corpus (docs/spec/dialects.md DIA-154, DIA-185), so each statement that the handle prepares
 * or runs is one statement message of its session (docs/spec/protocol.md PRT-65), and its answer is read as pdo_sqlite
 * reads a row (PRT-69). Every SQL surface of the connection reads and writes through it.
 *
 * The handle keeps the transaction state of its session from the statements it sends: BEGIN opens a transaction, and
 * COMMIT and ROLLBACK end it, as a failed statement does not (a flowmark session keeps its transaction open after a
 * failed statement, so it has no rollback of its own to learn of). After a failed COMMIT the state of the session is
 * unknown, so the session is closed, as is a session whose connection broke. Outside a transaction, a statement on a
 * closed session runs on a new session of the DSN, as a statement outside a transaction runs on any connection of a
 * pool (PRT-72); inside one, it is CONNECTION_LOST until the transaction ends.
 *
 * @internal
 */
final class MarkdownPdoAdapter extends PDO
{
    use QueriesByPrepare;

    private array $errorInfoValue = ['00000', null, null];
    private bool $transaction = false;
    private int $lastInsertId = 0;
    /**
     * The statement whose rows the session holds, which fetch answers. It is held weakly, so a statement that its
     * caller dropped is not kept alive by its connection.
     *
     * @var ?\WeakReference<MarkdownStatementAdapter>
     */
    private ?\WeakReference $active = null;

    /** @param \Closure(): MarkdownSession $dial opens a session of the DSN, with its _pragma settings stated */
    public function __construct(private MarkdownSession $session, private readonly \Closure $dial)
    {
    }

    /** Shuts the session down, so a statement that waits for its answer ends now; a cancellation runs it. */
    public function shutdown(): void
    {
        $this->session->shutdown();
    }

    /** Closes the session; the next statement outside a transaction opens a new one. */
    public function close(): void
    {
        $this->active = null;
        $this->session->close();
    }

    /**
     * Ends the transaction of a session that the client gave up, as a cancelled call does: the session is closed, and
     * the server rolls back the transaction of a closed connection (PRT-71).
     */
    public function abandon(): void
    {
        $this->close();
        $this->transaction = false;
    }

    /**
     * Runs one statement with its parameters in their wire form (PRT-67) and returns its answer. The rows that another
     * statement has not read yet are read first, since a new statement on the session ends them (PRT-66).
     *
     * @internal
     * @param list<mixed> $params
     * @return array{columns: list<array{name: string, type: string}>, rows: list<list<mixed>>, affected: int,
     *     last_insert_id: int, more: bool}
     */
    public function run(string $sql, array $params, ?MarkdownStatementAdapter $statement = null): array
    {
        if ($this->active !== null) {
            $held = $this->active->get();
            if ($held === null) {
                // No one can read the rows of a statement that is gone, so the session ends them (PRT-66).
                $this->active = null;
                $this->endRows();
            } elseif ($held !== $statement) {
                $held->drain();
            }
        }
        $this->active = null;
        $this->errorInfoValue = ['00000', null, null];
        $control = self::control($sql);
        if ($this->session->broken() && !$this->transaction && $control !== 'end') {
            $this->session = $this->call(fn(?int &$code): MarkdownSession => ($this->dial)());
        }
        try {
            $answer = $this->call(fn(?int &$code): array => $this->session->statement($sql, $params, $code));
        } catch (MarkdownError $error) {
            if ($control === 'end') {
                $this->transaction = false;
                // After a failed COMMIT the session state is unknown, so the session is closed.
                if (preg_match('/^\s*(COMMIT|END)\b/i', $sql) === 1) {
                    $this->session->close();
                }
            }
            throw $error;
        }
        if ($control === 'begin') {
            $this->transaction = true;
        } elseif ($control === 'end') {
            $this->transaction = false;
        }
        $this->lastInsertId = $answer['last_insert_id'];
        if ($answer['more'] && $statement !== null) {
            $this->active = \WeakReference::create($statement);
        }
        return $answer;
    }

    /**
     * The next batch of the rows of $statement, which the session holds.
     *
     * @internal
     * @return array{columns: list<array{name: string, type: string}>, rows: list<list<mixed>>, affected: int,
     *     last_insert_id: int, more: bool}
     */
    public function fetchRows(MarkdownStatementAdapter $statement): array
    {
        if ($this->active?->get() !== $statement) {
            throw new MarkdownError(
                Code::INTERNAL,
                'the rows of the statement are no longer held by the session',
                null,
                null
            );
        }
        $answer = $this->call(fn(?int &$code): array => $this->session->fetch($code));
        if (!$answer['more']) {
            $this->active = null;
        }
        return $answer;
    }

    /** Ends the rows of $statement that the session still holds. @internal */
    public function closeRows(MarkdownStatementAdapter $statement): void
    {
        if ($this->active?->get() !== $statement) {
            return;
        }
        $this->active = null;
        $this->endRows();
    }

    /**
     * Sends close for the rows that the session holds (PRT-66). A close that the server refuses leaves the rows to the
     * next statement, which ends them, so the session stays usable; a close whose connection broke has broken the
     * session, which the next statement outside a transaction dials again.
     */
    private function endRows(): void
    {
        try {
            $this->call(function (?int &$code): void {
                $this->session->closeRows($code);
            });
        } catch (MarkdownError) {
            $this->errorInfoValue = ['00000', null, null];
        }
    }

    /**
     * Runs $call on the session, and turns its OrmException into the PDO driver error of the statement. $call sets its
     * argument to the SQLite result code of a refusal.
     *
     * @template T
     * @param \Closure(?int &): T $call
     * @return T
     */
    private function call(\Closure $call): mixed
    {
        $resultCode = null;
        try {
            return $call($resultCode);
        } catch (OrmException $e) {
            // The message of an OrmException begins with its code, which fromDriver states again.
            $prefix = $e->code_ . ': ';
            $message = str_starts_with($e->getMessage(), $prefix)
                ? substr($e->getMessage(), strlen($prefix))
                : $e->getMessage();
            $error = new MarkdownError($e->code_, $message, $resultCode, $e);
            $this->errorInfoValue = $error->errorInfo;
            throw $error;
        }
    }

    /** Whether $sql begins or ends a transaction: 'begin', 'end', or '' for any other statement. */
    private static function control(string $sql): string
    {
        if (preg_match('/^\s*BEGIN\b/i', $sql) === 1) {
            return 'begin';
        }
        if (
            preg_match('/^\s*(COMMIT|END)\b/i', $sql) === 1
            || preg_match('/^\s*ROLLBACK\b(?!\s+(TRANSACTION\s+)?TO\b)/i', $sql) === 1
        ) {
            return 'end';
        }
        return '';
    }

    public function beginTransaction(): bool
    {
        $this->run('BEGIN', []);
        return true;
    }

    public function commit(): bool
    {
        $this->run('COMMIT', []);
        return true;
    }

    public function rollBack(): bool
    {
        $this->run('ROLLBACK', []);
        return true;
    }

    public function inTransaction(): bool
    {
        return $this->transaction;
    }

    public function exec(string $statement): int|false
    {
        return $this->run($statement, [])['affected'];
    }

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        return new MarkdownStatementAdapter($this, $query);
    }

    public function quote(string $string, int $type = PDO::PARAM_STR): string|false
    {
        return "'" . str_replace("'", "''", $string) . "'";
    }

    public function lastInsertId(?string $name = null): string|false
    {
        return (string) $this->lastInsertId;
    }

    public function getAttribute(int $attribute): mixed
    {
        return match ($attribute) {
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_STRINGIFY_FETCHES, PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_CASE => PDO::CASE_NATURAL,
            PDO::ATTR_ORACLE_NULLS => PDO::NULL_NATURAL,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_BOTH,
            PDO::ATTR_DRIVER_NAME => 'sqlite',
            PDO::ATTR_SERVER_VERSION => (string) ($this->run('SELECT sqlite_version()', [])['rows'][0][0] ?? ''),
            default => false,
        };
    }

    /**
     * The attributes that a SQLite connection sets: exceptions as the error mode, and natural fetches. Any other
     * value of them is refused.
     */
    public function setAttribute(int $attribute, mixed $value): bool
    {
        return match ($attribute) {
            PDO::ATTR_ERRMODE => $value === PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_STRINGIFY_FETCHES, PDO::ATTR_EMULATE_PREPARES => $value === false,
            default => false,
        };
    }

    public function errorCode(): ?string
    {
        return $this->errorInfoValue[0];
    }

    public function errorInfo(): array
    {
        return $this->errorInfoValue;
    }
}
