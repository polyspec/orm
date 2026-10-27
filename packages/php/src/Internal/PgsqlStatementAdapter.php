<?php

declare(strict_types=1);

namespace Polyspec\Orm\Internal;

use PDO;
use PDOException;
use PDOStatement;
use PgSql\Result;

/**
 * PDOStatement-compatible result cursor for PgsqlPdoAdapter.
 *
 * @internal
 */
final class PgsqlStatementAdapter extends PDOStatement
{
    private array $bindings = [];
    private array $bindingTypes = [];
    private array $boundRefs = [];
    private array $boundRefTypes = [];
    private array $boundColumns = [];
    private ?Result $result = null;
    private array $errorInfoValue = ['00000', null, null];
    private array $fetchMode = [];
    private int $row = 0;
    private int $affected = 0;
    private array $columns = [];

    public function __construct(private readonly PgsqlPdoAdapter $pdo, private readonly string $sourceSql)
    {
    }

    public function bindValue(string|int $param, mixed $value, int $type = PDO::PARAM_STR): bool
    {
        $index = $this->index($param);
        $this->bindings[$index] = $value;
        $this->bindingTypes[$index] = $type;
        return true;
    }

    public function bindParam(
        string|int $param,
        mixed &$var,
        int $type = PDO::PARAM_STR,
        int $maxLength = 0,
        mixed $driverOptions = null
    ): bool {
        $index = $this->index($param);
        $this->boundRefs[$index] =& $var;
        $this->boundRefTypes[$index] = $type;
        return true;
    }

    public function bindColumn(
        string|int $column,
        mixed &$var,
        int $type = PDO::PARAM_STR,
        int $maxLength = 0,
        mixed $driverOptions = null
    ): bool {
        $this->boundColumns[$column] =& $var;
        return true;
    }

    public function execute(?array $params = null): bool
    {
        if ($params !== null) {
            $this->bindings = [];
            foreach ($params as $key => $value) {
                $slot = is_int($key) ? $key : $this->index((string) $key);
                $this->bindings[$slot] = $value;
            }
            $this->bindingTypes = [];
        }
        foreach ($this->boundRefs as $index => &$value) {
            $this->bindings[$index] = $value;
            $this->bindingTypes[$index] = $this->boundRefTypes[$index] ?? PDO::PARAM_STR;
        }
        unset($value);
        [$sql, $order] = self::numberPlaceholders($this->sourceSql);
        $ordered = [];
        $types = [];
        foreach ($order as $slot) {
            if (!array_key_exists($slot, $this->bindings)) {
                throw new PDOException("parameter $slot was not bound");
            }
            $ordered[] = $this->bindings[$slot];
            $types[] = $this->bindingTypes[$slot] ?? null;
        }
        $this->errorInfoValue = ['00000', null, null];
        try {
            $this->result = $this->pdo->executeSql($sql, $ordered, false, $types);
        } catch (PDOException $error) {
            $this->errorInfoValue = $this->pdo->errorInfo();
            $this->pdo->reportError($error);
            return false;
        }
        $this->pdo->markActive($this);
        $this->row = 0;
        $this->affected = pg_affected_rows($this->result);
        $this->columns = [];
        for ($i = 0; $i < pg_num_fields($this->result); $i++) {
            $this->columns[] = [
                'name' => pg_field_name($this->result, $i),
                'type' => pg_field_type($this->result, $i),
                'oid' => pg_field_type_oid($this->result, $i),
                // The name of the table is read only when getColumnMeta asks for it: pg_field_table looks it up
                // with a query of its own, a server transaction that the statement did not ask for.
                'table' => null,
                'size' => pg_field_size($this->result, $i),
                'mod' => pg_field_num($this->result, pg_field_name($this->result, $i)),
            ];
        }
        return true;
    }

    public function fetch(
        int $mode = PDO::FETCH_DEFAULT,
        int $cursorOrientation = PDO::FETCH_ORI_NEXT,
        int $cursorOffset = 0
    ): mixed {
        if (!$this->result instanceof Result || $this->row >= pg_num_rows($this->result)) {
            return false;
        }
        $values = pg_fetch_row($this->result, $this->row++);
        if ($values === false) {
            return false;
        }
        $values = array_map(fn($value, $i) => $this->convert($value, $i), $values, array_keys($values));
        foreach ($this->boundColumns as $column => &$bound) {
            $index = is_int($column) ? $column - 1 : array_search($column, array_column($this->columns, 'name'), true);
            if (is_int($index) && array_key_exists($index, $values)) {
                $bound = $values[$index];
            }
        }
        unset($bound);
        $mode = $mode === PDO::FETCH_DEFAULT
            ? ($this->fetchMode[0] ?? $this->pdo->defaultFetchMode()[0] ?? PDO::FETCH_BOTH)
            : $mode;
        $names = array_column($this->columns, 'name');
        if ($this->pdo->caseMode() === PDO::CASE_LOWER) {
            $names = array_map('strtolower', $names);
        } elseif ($this->pdo->caseMode() === PDO::CASE_UPPER) {
            $names = array_map('strtoupper', $names);
        }
        $assoc = array_combine($names, $values) ?: [];
        return match ($mode) {
            PDO::FETCH_NUM => $values,
            PDO::FETCH_ASSOC => $assoc,
            PDO::FETCH_BOTH => $assoc + $values,
            PDO::FETCH_NAMED => $this->namedRow($names, $values),
            PDO::FETCH_COLUMN => $values[0] ?? false,
            PDO::FETCH_BOUND => true,
            PDO::FETCH_OBJ => (object) $assoc,
            default => throw new PDOException("unsupported fetch mode $mode"),
        };
    }

    public function fetchAll(int $mode = PDO::FETCH_DEFAULT, mixed ...$args): array
    {
        $rows = [];
        while (($row = $this->fetch($mode)) !== false) {
            $rows[] = $row;
        }
        return $rows;
    }

    public function fetchColumn(int $column = 0): mixed
    {
        $row = $this->fetch(PDO::FETCH_NUM);
        return $row === false ? false : ($row[$column] ?? false);
    }

    public function fetchObject(?string $class = 'stdClass', array $constructorArgs = []): object|false
    {
        $row = $this->fetch(PDO::FETCH_ASSOC);
        if ($row === false) {
            return false;
        }
        $class ??= 'stdClass';
        $object = new $class(...$constructorArgs);
        foreach ($row as $name => $value) {
            $object->$name = $value;
        }
        return $object;
    }

    public function closeCursor(): bool
    {
        if ($this->result instanceof Result) {
            pg_free_result($this->result);
            $this->result = null;
        }
        $this->pdo->finish($this);
        return true;
    }

    public function columnCount(): int
    {
        return count($this->columns);
    }

    public function rowCount(): int
    {
        return $this->affected;
    }

    public function getColumnMeta(int $column): array|false
    {
        if (!isset($this->columns[$column])) {
            return false;
        }
        if ($this->columns[$column]['table'] === null && $this->result instanceof Result) {
            $this->columns[$column]['table'] = pg_field_table($this->result, $column);
        }
        $meta = $this->columns[$column];
        return [
            'native_type' => $meta['type'],
            'pdo_type' => PDO::PARAM_STR,
            'table' => $meta['table'] ?: null,
            'name' => $meta['name'],
            'len' => $meta['size'],
            'precision' => null,
            'flags' => [],
            'pgsql:oid' => $meta['oid'],
        ];
    }

    public function setFetchMode(int $mode, mixed ...$args): true
    {
        $this->fetchMode = [$mode, ...$args];
        return true;
    }

    public function errorCode(): ?string
    {
        return $this->errorInfoValue[0];
    }

    public function errorInfo(): array
    {
        return $this->errorInfoValue;
    }

    public function getAttribute(int $name): mixed
    {
        return $this->pdo->getAttribute($name);
    }

    public function setAttribute(int $attribute, mixed $value): bool
    {
        return $this->pdo->setAttribute($attribute, $value);
    }

    public function nextRowset(): bool
    {
        return false;
    }

    public function getIterator(): \Iterator
    {
        return new PgsqlStatementIterator($this);
    }

    public function debugDumpParams(): ?bool
    {
        $parameters = $this->bindings;
        foreach ($this->boundRefs as $key => $value) {
            $parameters[$key] = $value;
        }
        ksort($parameters);
        $output = 'SQL: [' . strlen($this->sourceSql) . '] ' . $this->sourceSql . PHP_EOL;
        $output .= 'Params:  ' . count($parameters) . PHP_EOL;
        foreach ($parameters as $key => $_value) {
            $type = $this->bindingTypes[$key] ?? $this->boundRefTypes[$key] ?? PDO::PARAM_STR;
            if (is_int($key)) {
                $output .= 'Key: Position #' . $key . ':' . PHP_EOL;
                $output .= 'paramno=' . $key . PHP_EOL;
                $output .= 'name=[0] ""' . PHP_EOL;
            } else {
                $name = ':' . ltrim((string) $key, ':');
                $output .= 'Key: Name: [' . strlen($name) . '] ' . $name . PHP_EOL;
                $output .= 'paramno=' . $key . PHP_EOL;
                $output .= 'name=[' . strlen($name) . '] "' . $name . '"' . PHP_EOL;
            }
            $output .= 'is_param=1' . PHP_EOL;
            $output .= 'param_type=' . $type . PHP_EOL;
        }
        echo $output;
        return null;
    }

    /** @param list<string> $names @param list<mixed> $values */
    private function namedRow(array $names, array $values): array
    {
        $row = [];
        foreach ($names as $index => $name) {
            if (array_key_exists($name, $row)) {
                if (!is_array($row[$name])) {
                    $row[$name] = [$row[$name]];
                }
                $row[$name][] = $values[$index];
            } else {
                $row[$name] = $values[$index];
            }
        }
        return $row;
    }

    private function index(string|int $param): int|string
    {
        if (is_int($param)) {
            return $param - 1;
        }
        return str_starts_with($param, ':') ? substr($param, 1) : $param;
    }

    private function convert(?string $value, int $column): mixed
    {
        if ($value === null) {
            return $this->pdo->nullMode() === PDO::NULL_TO_STRING ? '' : null;
        }
        if ($value === '' && $this->pdo->nullMode() === PDO::NULL_EMPTY_STRING) {
            return null;
        }
        $type = $this->columns[$column]['type'] ?? '';
        if ($type === 'bytea') {
            $binary = pg_unescape_bytea($value);
            return $this->pdo->stringifyFetches() ? $binary : $this->byteaStream($binary);
        }
        if ($this->pdo->stringifyFetches()) {
            return $type === 'bool' ? ($value === 't' ? '1' : '0') : $value;
        }
        return match ($type) {
            'bool' => $value === 't',
            'int2', 'int4' => (int) $value,
            'int8' => filter_var($value, FILTER_VALIDATE_INT) === false ? $value : (int) $value,
            'float4', 'float8' => match ($value) {
                'NaN' => NAN,
                'Infinity' => INF,
                '-Infinity' => -INF,
                default => is_numeric($value) ? (float) $value : $value,
            },
            default => $value,
        };
    }

    private function byteaStream(string $value): mixed
    {
        $stream = fopen('php://memory', 'r+');
        if ($stream === false || fwrite($stream, $value) !== strlen($value) || !rewind($stream)) {
            if (is_resource($stream)) {
                fclose($stream);
            }
            throw new PDOException('could not create a PostgreSQL bytea stream');
        }
        return $stream;
    }

    /** Converts unquoted PDO placeholders to PostgreSQL's positional parameters. */
    private static function numberPlaceholders(string $sql): array
    {
        $out = '';
        $order = [];
        $state = 'normal';
        $length = strlen($sql);
        for ($i = 0; $i < $length; $i++) {
            $c = $sql[$i];
            $next = $sql[$i + 1] ?? '';
            if ($state === 'single') {
                $out .= $c;
                if ($c === "'" && $next === "'") {
                    $out .= $next;
                    $i++;
                } elseif ($c === "'") {
                    $state = 'normal';
                }
                continue;
            }
            if ($state === 'double') {
                $out .= $c;
                if ($c === '"' && $next === '"') {
                    $out .= $next;
                    $i++;
                } elseif ($c === '"') {
                    $state = 'normal';
                }
                continue;
            }
            if ($state === 'line') {
                $out .= $c;
                if ($c === "\n") {
                    $state = 'normal';
                }
                continue;
            }
            if ($state === 'block') {
                $out .= $c;
                if ($c === '*' && $next === '/') {
                    $out .= '/';
                    $i++;
                    $state = 'normal';
                }
                continue;
            }
            if ($c === "'") {
                $state = 'single';
                $out .= $c;
                continue;
            }
            if ($c === '"') {
                $state = 'double';
                $out .= $c;
                continue;
            }
            if ($c === '-' && $next === '-') {
                $state = 'line';
                $out .= '--';
                $i++;
                continue;
            }
            if ($c === '/' && $next === '*') {
                $state = 'block';
                $out .= '/*';
                $i++;
                continue;
            }
            if ($c === '?') {
                $order[] = count($order);
                $out .= '$' . count($order);
                continue;
            }
            if (
                $c === ':' && $next !== ':' && ($i === 0 || $sql[$i - 1] !== ':')
                && preg_match('/[A-Za-z_]/', $next) === 1
            ) {
                $start = $i + 1;
                $end = $start + 1;
                while ($end < $length && preg_match('/[A-Za-z0-9_]/', $sql[$end]) === 1) {
                    $end++;
                }
                $order[] = substr($sql, $start, $end - $start);
                $out .= '$' . count($order);
                $i = $end - 1;
                continue;
            }
            $out .= $c;
        }
        return [$out, $order];
    }
}
