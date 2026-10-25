<?php

declare(strict_types=1);

namespace Polyspec\Orm\Internal;

use PDO;
use PDOException;
use PDOStatement;
use PgSql\Connection;
use PgSql\Result;

/**
 * A PDO-compatible PostgreSQL handle backed only by the public ext-pgsql connection API.
 *
 * @internal
 */
final class PgsqlPdoAdapter extends \Pdo\Pgsql
{
    private array $errorInfoValue = ['00000', null, null];
    private int $errmode = PDO::ERRMODE_EXCEPTION;

    /**
     * Runs $call with an error handler of its own that keeps the E_WARNING PHP raises for a failing call, so the
     * failure reports its reason in the PDOException of the caller and no warning leaves the ORM; a notice or
     * deprecation still reaches PHP's handling. Returns the result and the warning, null when the call raised none.
     *
     * @template T
     * @param \Closure(): T $call
     * @return array{0: T, 1: ?string}
     */
    private static function withWarning(\Closure $call): array
    {
        $warning = null;
        set_error_handler(static function (int $level, string $message) use (&$warning): bool {
            $warning = $message;
            return true;
        }, E_WARNING);
        try {
            $result = $call();
        } finally {
            restore_error_handler();
        }
        return [$result, $warning];
    }

    /** The message of a failure: its own text, and the warning of PHP that states its reason when there is one. */
    private static function withReason(string $message, ?string $warning): string
    {
        return $warning === null ? $message : "$message: $warning";
    }
    private bool $stringifyFetches = false;
    private int $caseMode = PDO::CASE_NATURAL;
    private int $nullMode = PDO::NULL_NATURAL;
    private array $defaultFetchMode = [PDO::FETCH_BOTH];
    private ?PDOStatement $activeStatement = null;
    private ?\Closure $noticeCallback = null;
    private bool $cancelRequested = false;
    private int $affectedRows = 0;

    private readonly Connection $connection;

    public function __construct(string $dsn, ?string $username = null, ?string $password = null, ?array $options = null)
    {
        $conninfo = self::toConninfo($dsn, $username, $password, $options ?? []);
        [$connection, $warning] = self::withWarning(static fn() => pg_connect($conninfo, PGSQL_CONNECT_FORCE_NEW));
        if (!$connection instanceof Connection) {
            throw new PDOException(self::withReason('cannot connect to PostgreSQL', $warning));
        }
        $this->connection = $connection;
    }

    public static function connect(
        string $dsn,
        ?string $username = null,
        ?string $password = null,
        ?array $options = null
    ): static {
        return new static($dsn, $username, $password, $options);
    }

    public static function connectDsn(
        string $pdoDsn,
        ?string $username,
        ?string $password,
        int $statementTimeoutMs
    ): self {
        $options = ['options' => '-c TimeZone=UTC'
            . ($statementTimeoutMs > 0 ? ' -c statement_timeout=' . $statementTimeoutMs : '')];
        return new self($pdoDsn, $username, $password, $options);
    }

    /** @param array<string, mixed> $options */
    private static function toConninfo(string $dsn, ?string $username, ?string $password, array $options): string
    {
        if (!str_starts_with($dsn, 'pgsql:')) {
            return $dsn;
        }
        $fields = [];
        foreach (explode(';', substr($dsn, 6)) as $part) {
            if ($part === '') {
                continue;
            }
            [$key, $value] = array_pad(explode('=', $part, 2), 2, '');
            $fields[$key] = trim($value, "'\"");
        }
        if ($username !== null) {
            $fields['user'] = $username;
        }
        if ($password !== null) {
            $fields['password'] = $password;
        }
        foreach ($options as $key => $value) {
            if (is_string($value)) {
                $fields[$key] = $value;
            }
        }
        $quote = static fn(string $value): string => "'" . str_replace(['\\', "'"], ['\\\\', "\\'"], $value) . "'";
        $parts = [];
        foreach ($fields as $key => $value) {
            $parts[] = $key . '=' . $quote((string) $value);
        }
        return implode(' ', $parts);
    }

    public function cancelActive(): bool
    {
        $sent = pg_cancel_query($this->connection);
        $this->cancelRequested = $sent;
        return $sent;
    }

    public function beginTransaction(): bool
    {
        return $this->exec('BEGIN') !== false;
    }

    public function commit(): bool
    {
        return $this->exec('COMMIT') !== false;
    }

    public function rollBack(): bool
    {
        return $this->exec('ROLLBACK') !== false;
    }

    public function inTransaction(): bool
    {
        return in_array(
            pg_transaction_status($this->connection),
            [PGSQL_TRANSACTION_INTRANS, PGSQL_TRANSACTION_INERROR],
            true
        );
    }

    public function exec(string $statement): int|false
    {
        try {
            $this->executeSql($statement, [], true);
            return $this->affectedRows;
        } catch (PDOException $error) {
            $this->reportError($error);
            return false;
        }
    }

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        return new PgsqlStatementAdapter($this, $query);
    }

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        $statement = $this->prepare($query);
        if ($statement === false || !$statement->execute()) {
            return false;
        }
        if ($fetchMode !== null) {
            $statement->setFetchMode($fetchMode, ...$fetchModeArgs);
        }
        return $statement;
    }

    public function quote(string $string, int $type = PDO::PARAM_STR): string|false
    {
        if ($type === PDO::PARAM_LOB) {
            return "'\\x" . bin2hex($string) . "'";
        }
        return pg_escape_literal($this->connection, $string);
    }

    public function lastInsertId(?string $name = null): string|false
    {
        $sql = $name === null ? 'SELECT lastval()::text' : 'SELECT currval($1::regclass)::text';
        try {
            $result = $this->executeSql($sql, $name === null ? [] : [$name]);
        } catch (PDOException $error) {
            if ($this->errorInfoValue[0] === '55000') {
                return false;
            }
            throw $error;
        }
        $value = pg_fetch_result($result, 0, 0);
        pg_free_result($result);
        return $value === false ? false : (string) $value;
    }

    public function copyFromArray(
        string $tableName,
        array $rows,
        string $separator = "\t",
        string $nullAs = "\\N",
        ?string $fields = null
    ): bool {
        if ($fields === null) {
            return pg_copy_from($this->connection, $tableName, $rows, $separator, $nullAs);
        }
        $fieldNames = self::copyFieldList($fields);
        $command = 'COPY ' . self::quoteQualified($this->connection, $tableName) . ' ('
            . implode(', ', array_map(fn($field) => pg_escape_identifier($this->connection, $field), $fieldNames))
            . ') FROM STDIN WITH (FORMAT text, DELIMITER ' . pg_escape_literal($this->connection, $separator)
            . ', NULL ' . pg_escape_literal($this->connection, $nullAs) . ')';
        $connection = $this->connection;
        [$started, $warning] = self::withWarning(static fn() => pg_query($connection, $command));
        if (!$started instanceof Result || pg_result_status($started) !== PGSQL_COPY_IN) {
            throw new PDOException(
                pg_last_error($this->connection) ?: self::withReason('PostgreSQL COPY FROM did not start', $warning),
            );
        }
        pg_free_result($started);
        foreach ($rows as $row) {
            if (!pg_put_line($this->connection, (string) $row . "\n")) {
                pg_end_copy($this->connection);
                throw new PDOException(pg_last_error($this->connection) ?: 'PostgreSQL COPY FROM failed');
            }
        }
        if (!pg_end_copy($this->connection)) {
            throw new PDOException(pg_last_error($this->connection) ?: 'PostgreSQL COPY FROM failed');
        }
        return true;
    }

    public function copyFromFile(
        string $tableName,
        string $filename,
        string $separator = "\t",
        string $nullAs = "\\N",
        ?string $fields = null
    ): bool {
        [$contents, $warning] = self::withWarning(static fn() => file_get_contents($filename));
        if (!is_string($contents)) {
            throw new PDOException(self::withReason("cannot read PostgreSQL COPY file $filename", $warning));
        }
        $rows = $contents === '' ? [] : preg_split('/\r\n|\n|\r/', $contents);
        if ($rows !== false && (str_ends_with($contents, "\n") || str_ends_with($contents, "\r"))) {
            array_pop($rows);
        }
        return $this->copyFromArray($tableName, $rows ?: [], $separator, $nullAs, $fields);
    }

    public function copyToArray(
        string $tableName,
        string $separator = "\t",
        string $nullAs = "\\N",
        ?string $fields = null
    ): array|false {
        if ($fields === null) {
            return pg_copy_to($this->connection, $tableName, $separator, $nullAs);
        }
        $fieldNames = self::copyFieldList($fields);
        $columns = array_map(
            fn($field) => pg_escape_identifier($this->connection, $field),
            $fieldNames
        );
        $sql = 'SELECT ' . implode(', ', $columns) . ' FROM ' . self::quoteQualified($this->connection, $tableName);
        $result = $this->executeSql($sql, []);
        $rows = [];
        while (($values = pg_fetch_row($result)) !== false) {
            $rows[] = implode($separator, array_map(
                static function ($value) use ($nullAs, $separator): string {
                    if ($value === null) {
                        return $nullAs;
                    }
                    $escaped = self::copyEscape((string) $value, $separator);
                    return $escaped === $nullAs ? "\\" . $escaped : $escaped;
                },
                $values
            ));
        }
        pg_free_result($result);
        return $rows;
    }

    public function copyToFile(
        string $tableName,
        string $filename,
        string $separator = "\t",
        string $nullAs = "\\N",
        ?string $fields = null
    ): bool {
        $rows = $this->copyToArray($tableName, $separator, $nullAs, $fields);
        if ($rows === false) {
            return false;
        }
        $contents = $rows === [] ? '' : implode("\n", $rows) . "\n";
        [$written, $warning] = self::withWarning(static fn() => file_put_contents($filename, $contents));
        if ($written === false) {
            throw new PDOException(self::withReason("cannot write PostgreSQL COPY file $filename", $warning));
        }
        return true;
    }

    public function lobCreate(): string|false
    {
        $oid = pg_lo_create($this->connection);
        return $oid === false ? false : (string) $oid;
    }

    public function lobOpen(string $oid, string $mode = 'rb')
    {
        $lob = pg_lo_open($this->connection, $oid, $mode);
        if ($lob === false) {
            return false;
        }
        return PgsqlLargeObjectStream::open($lob, $mode);
    }

    public function lobUnlink(string $oid): bool
    {
        return pg_lo_unlink($this->connection, $oid);
    }

    public function getAttribute(int $attribute): mixed
    {
        return match ($attribute) {
            PDO::ATTR_ERRMODE => $this->errmode,
            PDO::ATTR_STRINGIFY_FETCHES => $this->stringifyFetches,
            PDO::ATTR_CASE => $this->caseMode,
            PDO::ATTR_ORACLE_NULLS => $this->nullMode,
            PDO::ATTR_DEFAULT_FETCH_MODE => $this->defaultFetchMode[0] ?? PDO::FETCH_BOTH,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_DRIVER_NAME => 'pgsql',
            PDO::ATTR_SERVER_VERSION => pg_version($this->connection)['server'] ?? '',
            PDO::ATTR_CONNECTION_STATUS => pg_connection_status($this->connection) === PGSQL_CONNECTION_OK
                ? 'PostgreSQL connection OK' : 'PostgreSQL connection bad',
            \Pdo\Pgsql::ATTR_DISABLE_PREPARES => true,
            default => false,
        };
    }

    public function setAttribute(int $attribute, mixed $value): bool
    {
        if (
            $attribute === PDO::ATTR_ERRMODE && in_array(
                $value,
                [PDO::ERRMODE_SILENT, PDO::ERRMODE_WARNING, PDO::ERRMODE_EXCEPTION],
                true
            )
        ) {
            $this->errmode = (int) $value;
            return true;
        }
        if ($attribute === PDO::ATTR_STRINGIFY_FETCHES) {
            $this->stringifyFetches = (bool) $value;
            return true;
        }
        if (
            $attribute === PDO::ATTR_CASE && in_array(
                $value,
                [PDO::CASE_NATURAL, PDO::CASE_LOWER, PDO::CASE_UPPER],
                true
            )
        ) {
            $this->caseMode = (int) $value;
            return true;
        }
        if (
            $attribute === PDO::ATTR_ORACLE_NULLS
            && in_array($value, [PDO::NULL_NATURAL, PDO::NULL_EMPTY_STRING, PDO::NULL_TO_STRING], true)
        ) {
            $this->nullMode = (int) $value;
            return true;
        }
        if ($attribute === PDO::ATTR_DEFAULT_FETCH_MODE) {
            $this->defaultFetchMode = is_array($value) ? array_values($value) : [(int) $value];
            return true;
        }
        if ($attribute === PDO::ATTR_EMULATE_PREPARES) {
            return !(bool) $value;
        }
        if ($attribute === \Pdo\Pgsql::ATTR_DISABLE_PREPARES) {
            return true;
        }
        return false;
    }

    /** @internal */
    public function errorMode(): int
    {
        return $this->errmode;
    }

    /** @internal */
    public function reportError(PDOException $error): void
    {
        if ($this->errmode === PDO::ERRMODE_WARNING) {
            trigger_error($error->getMessage(), E_USER_WARNING);
        } elseif ($this->errmode === PDO::ERRMODE_EXCEPTION) {
            throw $error;
        }
    }

    public function errorCode(): ?string
    {
        return $this->errorInfoValue[0];
    }

    public function errorInfo(): array
    {
        return $this->errorInfoValue;
    }

    public function escapeIdentifier(string $input): string
    {
        return pg_escape_identifier($this->connection, $input);
    }

    public function getPid(): int
    {
        return pg_get_pid($this->connection);
    }

    public function getNotify(int $fetchMode = PDO::FETCH_DEFAULT, int $timeoutMilliseconds = 0): array|false
    {
        $mode = match ($fetchMode) {
            PDO::FETCH_DEFAULT, PDO::FETCH_ASSOC => PGSQL_ASSOC,
            PDO::FETCH_NUM => PGSQL_NUM,
            PDO::FETCH_BOTH => PGSQL_BOTH,
            default => throw new PDOException("unsupported notification fetch mode $fetchMode"),
        };
        $notification = pg_get_notify($this->connection, $mode);
        if ($notification !== false || $timeoutMilliseconds <= 0) {
            return $notification;
        }
        $socket = pg_socket($this->connection);
        if (!is_resource($socket)) {
            throw new PDOException('PostgreSQL notification socket is unavailable');
        }
        $read = [$socket];
        $write = null;
        $except = null;
        $seconds = intdiv($timeoutMilliseconds, 1000);
        $microseconds = ($timeoutMilliseconds % 1000) * 1000;
        [$ready, $warning] = self::withWarning(
            static function () use (&$read, &$write, &$except, $seconds, $microseconds): int|false {
                return stream_select($read, $write, $except, $seconds, $microseconds);
            },
        );
        if ($ready === false) {
            throw new PDOException(self::withReason('PostgreSQL notification wait failed', $warning));
        }
        if ($ready === 0) {
            return false;
        }
        if (!pg_consume_input($this->connection)) {
            throw new PDOException(pg_last_error($this->connection) ?: 'PostgreSQL notification read failed');
        }
        return pg_get_notify($this->connection, $mode);
    }

    public function setNoticeCallback(?callable $callback): void
    {
        $this->noticeCallback = $callback === null ? null : $callback(...);
    }

    /** @internal */
    public function executeSql(string $sql, array $params, bool $simpleQuery = false, array $paramTypes = []): Result
    {
        if ($this->activeStatement !== null) {
            $this->activeStatement->closeCursor();
        }
        $this->errorInfoValue = ['00000', null, null];
        $this->cancelRequested = false;
        $values = array_map(
            static fn($value, $i) => self::textParam($value, $paramTypes[$i] ?? null),
            $params,
            array_keys($params)
        );
        $sent = $simpleQuery
            ? pg_send_query($this->connection, $sql)
            : pg_send_query_params($this->connection, $sql, $values);
        if (!$sent) {
            $this->raiseConnectionError();
        }
        $socket = pg_socket($this->connection);
        if (!is_resource($socket)) {
            $this->raiseConnectionError();
        }
        $lastResult = null;
        $queryError = null;
        while (true) {
            while (pg_connection_busy($this->connection)) {
                $read = [$socket];
                $write = null;
                $except = null;
                // A select interrupted by a signal fails with a warning; the signal is dispatched and the wait repeats.
                [$ready] = self::withWarning(static function () use (&$read, &$write, &$except): int|false {
                    return stream_select($read, $write, $except, null);
                });
                if ($ready === false) {
                    if (function_exists('pcntl_signal_dispatch')) {
                        pcntl_signal_dispatch();
                    }
                    continue;
                }
                if ($ready > 0 && !pg_consume_input($this->connection)) {
                    $this->raiseConnectionError();
                }
                if ($ready > 0) {
                    pg_connection_busy($this->connection);
                    $this->dispatchNotices();
                }
                if (function_exists('pcntl_signal_dispatch')) {
                    pcntl_signal_dispatch();
                }
            }
            $next = pg_get_result($this->connection);
            if (!$next instanceof Result) {
                break;
            }
            $status = pg_result_status($next);
            if ($status !== PGSQL_TUPLES_OK && $status !== PGSQL_COMMAND_OK) {
                $state = pg_result_error_field($next, PGSQL_DIAG_SQLSTATE) ?: 'HY000';
                $message = trim(pg_result_error($next));
                $this->errorInfoValue = [$state, null, $message];
                $queryError ??= new PDOException($message, 0);
                pg_free_result($next);
                continue;
            }
            if ($lastResult instanceof Result) {
                pg_free_result($lastResult);
            }
            $lastResult = $next;
        }
        if ($queryError !== null) {
            if ($lastResult instanceof Result) {
                pg_free_result($lastResult);
            }
            throw $queryError;
        }
        if (!$lastResult instanceof Result) {
            if ($this->cancelRequested) {
                $this->errorInfoValue = ['57014', null, 'canceling statement due to user request'];
                throw new PDOException('canceling statement due to user request', 0);
            }
            $this->raiseConnectionError();
        }
        $this->affectedRows = pg_affected_rows($lastResult);
        $this->errorInfoValue = ['00000', null, null];
        return $lastResult;
    }

    /** @internal */
    public function markActive(PDOStatement $statement): void
    {
        $this->activeStatement = $statement;
    }

    /** @internal */
    public function finish(PDOStatement $statement): void
    {
        if ($this->activeStatement === $statement) {
            $this->activeStatement = null;
        }
    }

    /** @internal */
    public function stringifyFetches(): bool
    {
        return $this->stringifyFetches;
    }

    /** @internal @return array<int, mixed> */
    public function defaultFetchMode(): array
    {
        return $this->defaultFetchMode;
    }

    /** @internal */
    public function caseMode(): int
    {
        return $this->caseMode;
    }

    /** @internal */
    public function nullMode(): int
    {
        return $this->nullMode;
    }

    /** @internal */
    public function noticeCallback(): ?\Closure
    {
        return $this->noticeCallback;
    }

    /** @return list<string> */
    private static function copyFieldList(string $fields): array
    {
        $names = array_map('trim', explode(',', $fields));
        if ($names === [] || in_array('', $names, true)) {
            throw new PDOException('PostgreSQL COPY fields must be a comma-separated list of column names');
        }
        return array_map(static function (string $name): string {
            if (strlen($name) >= 2 && $name[0] === '"' && $name[strlen($name) - 1] === '"') {
                return str_replace('""', '"', substr($name, 1, -1));
            }
            return $name;
        }, $names);
    }

    private static function quoteQualified(Connection $connection, string $name): string
    {
        return implode('.', array_map(fn($part) => pg_escape_identifier($connection, $part), explode('.', $name)));
    }

    private static function copyEscape(string $value, string $separator): string
    {
        $escaped = '';
        for ($i = 0, $length = strlen($value); $i < $length; $i++) {
            $character = $value[$i];
            $escaped .= match ($character) {
                "\\" => "\\\\",
                "\t" => "\\t",
                "\n" => "\\n",
                "\r" => "\\r",
                $separator => "\\" . $character,
                default => $character,
            };
        }
        return $escaped;
    }

    private static function textParam(mixed $value, ?int $type = null): ?string
    {
        if ($value === null || $type === PDO::PARAM_NULL) {
            return null;
        }
        if ($type === PDO::PARAM_LOB) {
            if (is_resource($value)) {
                $value = stream_get_contents($value);
            }
            if (!is_string($value)) {
                throw new PDOException('PostgreSQL LOB parameter must be a string or stream');
            }
            return '\\x' . bin2hex($value);
        }
        if (is_bool($value) || $type === PDO::PARAM_BOOL) {
            return $value ? 'true' : 'false';
        }
        if (is_string($value) || is_int($value) || is_float($value)) {
            return (string) $value;
        }
        if ($value instanceof \Stringable) {
            return (string) $value;
        }
        throw new PDOException('PostgreSQL parameter cannot be represented as text');
    }

    private function dispatchNotices(): void
    {
        $notices = pg_last_notice($this->connection, PGSQL_NOTICE_ALL);
        pg_last_notice($this->connection, PGSQL_NOTICE_CLEAR);
        if ($this->noticeCallback !== null && is_array($notices)) {
            foreach ($notices as $notice) {
                ($this->noticeCallback)((string) $notice);
            }
        }
    }

    private function raiseConnectionError(): never
    {
        $message = pg_last_error($this->connection) ?: 'PostgreSQL query failed';
        $this->errorInfoValue = ['08006', null, $message];
        throw new PDOException($message, 0);
    }
}
