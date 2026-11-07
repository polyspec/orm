<?php

declare(strict_types=1);

namespace Polyspec\Orm\Internal;

use PDO;
use PDOStatement;
use Polyspec\Orm\Code;

/**
 * A prepared statement of a markdown connection (MarkdownPdoAdapter): each execute sends its text and its bound values
 * as one statement message, and its rows are read as pdo_sqlite reads them (docs/spec/protocol.md PRT-66, PRT-67,
 * PRT-69).
 *
 * @internal
 */
final class MarkdownStatementAdapter extends PDOStatement
{
    use FetchesAllRows;
    use StatementState;

    /** @var array<int|string, array{0: mixed, 1: int}> bound values with their PDO types, by position or name */
    private array $bindings = [];
    /** @var list<array{name: string, type: string}> */
    private array $columns = [];
    /** @var list<list<mixed>> the batch of rows the statement holds, in their wire form */
    private array $rows = [];
    private int $next = 0;
    private bool $more = false;
    private int $affected = 0;
    /** @var list<string> the storage class of each value of the current row, as pdo_sqlite reports it */
    private array $kinds = [];

    public function __construct(private readonly MarkdownPdoAdapter $pdo, private readonly string $sourceSql)
    {
    }

    public function bindValue(string|int $param, mixed $value, int $type = PDO::PARAM_STR): bool
    {
        $this->bindings[self::slotOf($param)] = [$value, $type];
        return true;
    }

    public function execute(?array $params = null): bool
    {
        if ($params !== null) {
            $this->bindings = array_map(
                static fn (mixed $value): array => [$value, PDO::PARAM_STR],
                self::executeSlots($params),
            );
        }
        [$sql, $order] = self::positional($this->sourceSql);
        $wire = [];
        foreach ($order as $i => $slot) {
            $slot ??= $i;
            if (!array_key_exists($slot, $this->bindings)) {
                throw new MarkdownError(Code::CONFIG, "parameter $slot of the statement was not bound", null, null);
            }
            [$value, $type] = $this->bindings[$slot];
            $wire[] = self::param($value, $type);
        }
        $this->reset();
        try {
            $answer = $this->pdo->run($sql, $wire, $this);
        } catch (MarkdownError $error) {
            $this->errorInfoValue = $error->errorInfo;
            throw $error;
        }
        $this->errorInfoValue = ['00000', null, null];
        $this->columns = $answer['columns'];
        $this->rows = $answer['rows'];
        $this->more = $answer['more'];
        $this->affected = $answer['affected'];
        $this->kinds = $this->rows === [] ? [] : $this->rowKinds($this->rows[0]);
        return true;
    }

    /** Reads every batch of rows that the session still holds, so a new statement on the session can run. @internal */
    public function drain(): void
    {
        while ($this->more) {
            $answer = $this->pdo->fetchRows($this);
            array_push($this->rows, ...$answer['rows']);
            $this->more = $answer['more'];
        }
    }

    private function reset(): void
    {
        $this->columns = [];
        $this->rows = [];
        $this->next = 0;
        $this->more = false;
        $this->affected = 0;
        $this->kinds = [];
    }

    /** @return list<mixed>|false the next row, as pdo_sqlite reads its values */
    private function nextRow(): array|false
    {
        while ($this->next >= count($this->rows)) {
            if (!$this->more) {
                return false;
            }
            $answer = $this->pdo->fetchRows($this);
            $this->rows = $answer['rows'];
            $this->more = $answer['more'];
            $this->next = 0;
        }
        $raw = $this->rows[$this->next++];
        $this->kinds = $this->rowKinds($raw);
        $values = [];
        try {
            foreach ($raw as $i => $cell) {
                $values[] = $this->cell($cell, $this->columns[$i]['type'] ?? '');
            }
        } catch (MarkdownError $error) {
            // A row that the read refuses stops it: close ends the rows that follow, and the refusal is the error
            // whatever the close answers (PRT-66).
            $this->closeCursor();
            throw $error;
        }
        return $values;
    }

    public function fetch(
        int $mode = PDO::FETCH_DEFAULT,
        int $cursorOrientation = PDO::FETCH_ORI_NEXT,
        int $cursorOffset = 0
    ): mixed {
        $values = $this->nextRow();
        if ($values === false) {
            return false;
        }
        $mode = $mode === PDO::FETCH_DEFAULT ? ($this->fetchMode[0] ?? PDO::FETCH_BOTH) : $mode;
        $names = array_column($this->columns, 'name');
        return match ($mode) {
            PDO::FETCH_NUM => $values,
            PDO::FETCH_ASSOC => array_combine($names, $values),
            PDO::FETCH_BOTH => array_combine($names, $values) + $values,
            PDO::FETCH_COLUMN => $values[$this->fetchMode[1] ?? 0] ?? false,
            PDO::FETCH_OBJ => (object) array_combine($names, $values),
            default => throw new MarkdownError(Code::INTERNAL, "fetch mode $mode is not supported", null, null),
        };
    }

    public function closeCursor(): bool
    {
        if ($this->more) {
            $this->more = false;
            $this->pdo->closeRows($this);
        }
        $this->rows = [];
        $this->next = 0;
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

    /**
     * The metadata of a column as pdo_sqlite gives it: the storage class of its value in the current row, whether that
     * value is a blob, and the declared type of the column.
     */
    public function getColumnMeta(int $column): array|false
    {
        if (!isset($this->columns[$column])) {
            return false;
        }
        $kind = $this->kinds[$column] ?? 'null';
        $meta = [
            'native_type' => $kind === 'blob' ? 'string' : $kind,
            'pdo_type' => match ($kind) {
                'null' => PDO::PARAM_NULL,
                'integer' => PDO::PARAM_INT,
                default => PDO::PARAM_STR,
            },
            'flags' => $kind === 'blob' ? ['blob'] : [],
            'name' => $this->columns[$column]['name'],
            'len' => -1,
            'precision' => 0,
        ];
        if ($this->columns[$column]['type'] !== '') {
            $meta['sqlite:decl_type'] = $this->columns[$column]['type'];
        }
        return $meta;
    }

    public function nextRowset(): bool
    {
        return false;
    }

    public function getIterator(): \Iterator
    {
        return (function (): \Generator {
            while (($row = $this->fetch()) !== false) {
                yield $row;
            }
        })();
    }

    /** The slot of a bound parameter: a position from 0, or a name without its colon. */
    /**
     * The value of a parameter in the form of a statement message (PRT-67), in the type that it is bound with:
     * PARAM_NULL and null as NULL, PARAM_INT as an integer, PARAM_BOOL as the integer 1 or 0, PARAM_LOB as a blob, a
     * float as a number, and any other value as its text, as pdo_sqlite binds it; a text that is not UTF-8, a blob and
     * an infinity take the forms that JSON cannot hold.
     */
    private static function param(mixed $value, int $type): mixed
    {
        if ($value === null || $type === PDO::PARAM_NULL) {
            return null;
        }
        if ($type === PDO::PARAM_BOOL) {
            return $value ? 1 : 0;
        }
        if (is_float($value) && $type !== PDO::PARAM_INT && $type !== PDO::PARAM_LOB) {
            if (is_nan($value)) {
                throw new MarkdownError(Code::CONFIG, 'a statement parameter of NaN has no JSON form', null, null);
            }
            return is_infinite($value) ? ['float' => $value > 0 ? '+Inf' : '-Inf'] : $value;
        }
        if ($type === PDO::PARAM_LOB) {
            if (is_resource($value)) {
                $value = stream_get_contents($value);
            }
            if (!is_string($value)) {
                throw new MarkdownError(Code::CONFIG, 'a blob parameter must be a string or a stream', null, null);
            }
            return ['bytes' => base64_encode($value)];
        }
        if ($type === PDO::PARAM_INT) {
            return is_int($value) ? $value : (int) $value;
        }
        if (is_bool($value)) {
            $value = $value ? '1' : '';
        }
        if (!is_scalar($value) && !$value instanceof \Stringable) {
            throw new MarkdownError(Code::CONFIG, 'a parameter of type ' . get_debug_type($value)
                . ' has no text', null, null);
        }
        $text = (string) $value;
        return mb_check_encoding($text, 'UTF-8') ? $text : ['text' => base64_encode($text)];
    }

    /**
     * One value of a row as pdo_sqlite reads it (PRT-69): an integer, a float, a string, a blob as a string, or null.
     * A column of REAL affinity holds a real, which an answer writes as an integer when it has no fraction.
     */
    private function cell(mixed $raw, string $declared): mixed
    {
        if (is_array($raw)) {
            if (isset($raw['bytes']) && is_string($raw['bytes'])) {
                return self::base64($raw['bytes']);
            }
            if (isset($raw['text']) && is_string($raw['text'])) {
                return self::base64($raw['text']);
            }
            return match ($raw['float'] ?? null) {
                '+Inf' => INF,
                '-Inf' => -INF,
                default => throw new MarkdownError(Code::INTERNAL, 'the cell ' . json_encode($raw)
                    . ' is no value', null, null),
            };
        }
        if (is_int($raw) && self::realAffinity($declared)) {
            return (float) $raw;
        }
        if ($raw !== null && !is_int($raw) && !is_float($raw) && !is_string($raw)) {
            throw new MarkdownError(Code::INTERNAL, 'the cell ' . json_encode($raw) . ' is no value', null, null);
        }
        return $raw;
    }

    /** @param list<mixed> $raw @return list<string> the storage class of each value of a row in its wire form */
    private function rowKinds(array $raw): array
    {
        $kinds = [];
        foreach ($raw as $i => $cell) {
            $kinds[] = match (true) {
                $cell === null => 'null',
                is_array($cell) && isset($cell['bytes']) => 'blob',
                is_array($cell) && isset($cell['float']), is_float($cell) => 'double',
                is_int($cell) => self::realAffinity($this->columns[$i]['type'] ?? '') ? 'double' : 'integer',
                default => 'string',
            };
        }
        return $kinds;
    }

    /** Whether a column of the declared type has REAL affinity (SQLite's rules of column affinity). */
    private static function realAffinity(string $declared): bool
    {
        $type = strtoupper($declared);
        return !str_contains($type, 'INT') && !str_contains($type, 'CHAR') && !str_contains($type, 'CLOB')
            && !str_contains($type, 'TEXT') && !str_contains($type, 'BLOB')
            && (str_contains($type, 'REAL') || str_contains($type, 'FLOA') || str_contains($type, 'DOUB'));
    }

    private static function base64(string $text): string
    {
        $bytes = base64_decode($text, true);
        if ($bytes === false) {
            throw new MarkdownError(Code::INTERNAL, "the cell $text holds no base64 text", null, null);
        }
        return $bytes;
    }

    /**
     * The statement text with its named placeholders written as `?`, and the slot of each placeholder in order: null
     * for a `?`, whose slot is its position, or the name of a `:name`.
     *
     * @return array{0: string, 1: list<string|null>}
     */
    private static function positional(string $sql): array
    {
        $out = '';
        $order = [];
        $length = strlen($sql);
        for ($i = 0; $i < $length; $i++) {
            $c = $sql[$i];
            if ($c === "'" || $c === '"' || $c === '`') {
                $end = $i + 1;
                while ($end < $length && ($sql[$end] !== $c || ($sql[$end + 1] ?? '') === $c)) {
                    $end += $sql[$end] === $c ? 2 : 1;
                }
                $out .= substr($sql, $i, $end - $i + 1);
                $i = $end;
                continue;
            }
            if ($c === '-' && ($sql[$i + 1] ?? '') === '-') {
                $end = strpos($sql, "\n", $i);
                $end = $end === false ? $length : $end;
                $out .= substr($sql, $i, $end - $i);
                $i = $end - 1;
                continue;
            }
            if ($c === '/' && ($sql[$i + 1] ?? '') === '*') {
                $end = strpos($sql, '*/', $i + 2);
                $end = $end === false ? $length : $end + 2;
                $out .= substr($sql, $i, $end - $i);
                $i = $end - 1;
                continue;
            }
            if ($c === '?') {
                $order[] = null;
                $out .= '?';
                continue;
            }
            if (
                $c === ':' && preg_match('/\G:([A-Za-z_][A-Za-z0-9_]*)/', $sql, $m, 0, $i) === 1
                && ($i === 0 || $sql[$i - 1] !== ':')
            ) {
                $order[] = $m[1];
                $out .= '?';
                $i += strlen($m[0]) - 1;
                continue;
            }
            $out .= $c;
        }
        return [$out, $order];
    }
}
