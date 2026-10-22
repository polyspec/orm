<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * The catalog connection (SCH-6a, docs/spec/interfaces.md "Qualified native Rust table metadata" to "Qualified Rust table
 * pages"). It reads table metadata and bounded table pages, runs validated read-only queries and changes rows with explicit
 * commands. Its descriptors and pages do not authorize a row change; each change re-reads its original row inside its own
 * transaction and compares it with the snapshot. Modelled on the Go catalog connection (packages/go/orm/catalog*.go).
 */
final class Catalog
{
    private const METADATA_ROWS = 2048;
    private const METADATA_BYTES = 4194304;
    private const PAGE_BYTES = 8388608;
    private const SNAPSHOT_BYTES = 8388608;
    private const DEFAULT_ROWS = 100000;
    private const DEFAULT_BYTES = 67108864;
    private const SQL_BYTES = 262144;
    private const MYSQL_INTEGER_TYPES = ['LONG', 'LONGLONG', 'SHORT', 'TINY', 'INT24', 'YEAR'];
    private const MYSQL_STRING_TYPES = ['VAR_STRING', 'STRING', 'BLOB', 'TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB', 'ENUM', 'SET'];

    /** Selects the native kind of a relation by its namespace and name. */
    private const KIND_SQL = [
        'mysql' => 'SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
        'postgres' => 'SELECT c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=? AND c.relname=?',
        'sqlite' => 'SELECT type FROM pragma_table_list WHERE schema=? AND name=?',
    ];

    /**
     * Selects the columns of a relation in physical order: name, native type, nullable, generated, primary-key ordinal,
     * automatic key, default expression and whether the default is an expression.
     */
    private const COLUMNS_SQL = [
        'mysql' => "SELECT c.COLUMN_NAME,c.COLUMN_TYPE,c.IS_NULLABLE='YES',(c.GENERATION_EXPRESSION IS NOT NULL AND c.GENERATION_EXPRESSION<>''),COALESCE(pk.ORDINAL_POSITION,0),(c.EXTRA LIKE '%auto_increment%'),c.COLUMN_DEFAULT,(c.EXTRA LIKE '%DEFAULT_GENERATED%') FROM information_schema.COLUMNS c LEFT JOIN information_schema.KEY_COLUMN_USAGE pk ON pk.CONSTRAINT_SCHEMA=c.TABLE_SCHEMA AND pk.TABLE_NAME=c.TABLE_NAME AND pk.COLUMN_NAME=c.COLUMN_NAME AND pk.CONSTRAINT_NAME='PRIMARY' WHERE c.TABLE_SCHEMA=? AND c.TABLE_NAME=? ORDER BY c.ORDINAL_POSITION",
        'postgres' => 'SELECT a.attname::text,format_type(a.atttypid,a.atttypmod),NOT a.attnotnull,(a.attgenerated<>\'\' OR a.attidentity=\'a\'),COALESCE(k.ord,0),(a.attidentity<>\'\'),pg_get_expr(d.adbin,d.adrelid),(d.adbin IS NOT NULL) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ord) ON k.attnum=a.attnum WHERE n.nspname=? AND c.relname=? AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum',
        'sqlite' => 'SELECT name,type,NOT "notnull",hidden<>0,pk,0,dflt_value,(dflt_value IS NOT NULL) FROM pragma_table_xinfo(?,?) ORDER BY cid',
    ];

    /** The keywords that a read query never uses as a statement or clause; a query that contains one is refused. */
    private const WRITE_WORDS = [
        'INSERT' => true, 'UPDATE' => true, 'DELETE' => true, 'MERGE' => true, 'UPSERT' => true, 'CREATE' => true,
        'DROP' => true, 'ALTER' => true, 'TRUNCATE' => true, 'RENAME' => true, 'GRANT' => true, 'REVOKE' => true,
        'CALL' => true, 'DO' => true, 'INTO' => true, 'LOCK' => true, 'SHARE' => true, 'PROCEDURE' => true, 'LOAD' => true,
        'COPY' => true, 'ATTACH' => true, 'DETACH' => true, 'PRAGMA' => true, 'VACUUM' => true, 'REINDEX' => true,
        'ANALYZE' => true,
    ];

    private function __construct(
        private readonly Db $db,
        private readonly string $dialect,
    ) {
    }

    /**
     * Opens the catalog connection of a mysql, postgres or sqlite DSN. A markdown DSN is refused. A SQLite DSN must name an
     * existing regular file, and the connection never creates one.
     */
    public static function connect(string $dsn): self
    {
        if (preg_match('#^markdown://#i', $dsn) === 1) {
            throw new OrmException(Code::CONFIG,
                'CATALOG_DSN: a markdown corpus has no database catalog; give a mysql, postgres or sqlite DSN');
        }
        [$driver, $pdoDsn] = Orm::parseDsn($dsn);
        if ($driver === 'sqlite') {
            // A symbolic link is not a regular file.
            $path = substr($pdoDsn, strlen('sqlite:'));
            if (is_link($path) || !is_file($path)) {
                throw new OrmException(Code::CONFIG, 'CATALOG_SQLITE_FILE: expected an existing regular file');
            }
        }
        return new self(Orm::connect($dsn, new Config()), $driver);
    }

    /** The database of the connection: mysql, postgres or sqlite. */
    public function dialect(): string
    {
        return $this->dialect;
    }

    /** Releases the connection. */
    public function close(): void
    {
        $this->db->close();
    }

    /** The namespace of the connection: the current schema of PostgreSQL, the current database of MySQL and main for SQLite. */
    public function currentNamespace(): string
    {
        if ($this->dialect === 'sqlite') {
            return 'main';
        }
        $query = $this->dialect === 'postgres' ? 'SELECT current_schema()' : 'SELECT DATABASE()';
        return $this->read(function (\PDO $pdo) use ($query): string {
            $raw = $this->query($pdo, $query, [], 2, self::METADATA_BYTES);
            if (count($raw['rows']) !== 1 || count($raw['rows'][0]) !== 1) {
                throw new OrmException(Code::TABLE_NAMESPACE_UNAVAILABLE, 'the connection reported no single namespace');
            }
            $name = $raw['rows'][0][0];
            if (!is_string($name)) {
                throw new OrmException(Code::TABLE_NAMESPACE_UNAVAILABLE, 'the connection reported no text namespace');
            }
            self::checkName($name);
            return $name;
        });
    }

    /**
     * Reads the metadata of an explicitly qualified table, {namespace, name}, in a read-only session. The descriptor must
     * be the same when it is read again within the session.
     *
     * @param array{namespace: string, name: string} $table
     */
    public function describeTable(array $table): CatalogTableMetadata
    {
        $ref = self::tableRef($table);
        return $this->read(fn (\PDO $pdo): CatalogTableMetadata => $this->describe($pdo, $ref));
    }

    /**
     * Reads one bounded page of an explicitly qualified table in primary-key order, in a fresh read-only session. A table
     * without a primary key has no defined order. The descriptor must be the same before and after the read.
     *
     * @param array{namespace: string, name: string} $table
     */
    public function tablePage(array $table, int $limit, int $offset): CatalogTablePage
    {
        $ref = self::tableRef($table);
        if ($limit < 1 || $limit > 1000 || $offset < 0 || $offset > 1000000) {
            throw new OrmException(Code::TABLE_PAGE_INVALID, 'limit requires 1..1000 and offset 0..1000000');
        }
        return $this->read(function (\PDO $pdo) use ($ref, $limit, $offset): CatalogTablePage {
            $metadata = $this->describe($pdo, $ref);
            if ($metadata->columns === []) {
                throw new OrmException(Code::TABLE_PAGE_UNSUPPORTED, 'relation has no selectable columns');
            }
            $sql = 'SELECT ' . self::quoteList(self::columnNames($metadata), $this->dialect)
                . ' FROM ' . self::qualified($ref, $this->dialect);
            if ($metadata->primaryKey !== []) {
                $sql .= ' ORDER BY ' . self::quoteList($metadata->primaryKey, $this->dialect);
            }
            // One extra row is the sentinel that reports hasMore.
            $sql .= ' LIMIT ' . ($limit + 1) . ' OFFSET ' . $offset;
            $raw = $this->query($pdo, $sql, [], $limit + 1, self::PAGE_BYTES);
            self::sameNames($raw['names'], $metadata, Code::TABLE_PAGE_METADATA_CHANGED);
            if ($this->describe($pdo, $ref) != $metadata) {
                throw new OrmException(Code::TABLE_PAGE_METADATA_CHANGED, 'descriptor changed during read');
            }
            $rows = self::convertRows($raw, self::nativeTypes($metadata));
            $hasMore = count($rows) > $limit;
            if ($hasMore) {
                $rows = array_slice($rows, 0, $limit);
            }
            return new CatalogTablePage($metadata, new CatalogResult(self::columnNames($metadata), $rows),
                $limit, $offset, $metadata->primaryKey, $hasMore);
        });
    }

    /**
     * Captures the row at index of a page as a snapshot. The table must have a reliable row identity, and the page must be
     * a page of that table as tablePage reads it.
     */
    public function rowSnapshotFromPage(CatalogTablePage $page, int $index): CatalogRowSnapshot
    {
        $metadata = $page->metadata;
        try {
            self::checkName($metadata->table['namespace']);
            self::checkName($metadata->table['name']);
        } catch (OrmException $e) {
            throw new OrmException(Code::ROW_SNAPSHOT_INVALID, 'invalid original row or descriptor: ' . $e->getMessage(), $e);
        }
        if ($page->limit < 1 || $page->limit > 1000 || $page->offset < 0 || $page->offset > 1000000) {
            throw new OrmException(Code::ROW_SNAPSHOT_INVALID, 'invalid page bounds');
        }
        $rows = $page->result->rows;
        if (count($rows) > $page->limit || ($page->hasMore && count($rows) !== $page->limit)
            || $page->orderBy !== $metadata->primaryKey) {
            throw new OrmException(Code::ROW_SNAPSHOT_INVALID, 'page rows or order do not match its bounds');
        }
        $keyIndexes = self::descriptorKeys($metadata);
        if ($page->result->columns !== self::columnNames($metadata)) {
            throw new OrmException(Code::ROW_SNAPSHOT_INVALID, 'projection differs from descriptor');
        }
        if ($index < 0 || $index >= count($rows)) {
            throw new OrmException(Code::ROW_SNAPSHOT_INVALID, "row index $index outside the page");
        }
        $cells = $rows[$index];
        self::checkCells($metadata, $cells);
        return new CatalogRowSnapshot($metadata, $cells, $keyIndexes, self::revision($metadata, $cells));
    }

    /**
     * Runs one read query (SELECT, WITH or VALUES) in a fresh read-only session. A query that writes, locks or has more than
     * one statement fails with QUERY_READ_ONLY before it runs. Placeholders are `?`; a result over a limit fails, never truncated.
     *
     * @param list<mixed> $params
     */
    public function readOnlyQuery(string $sql, array $params = [], int $maxRows = 0, int $maxBytes = 0): CatalogResult
    {
        return $this->readOnly($sql, $params, $maxRows, $maxBytes, false);
    }

    /**
     * Runs one read query like readOnlyQuery, and types each cell by its native column type: float cells hold their IEEE-754
     * bits, UNSIGNED integers are unsigned cells, DECIMAL is plain text, date, time and datetime hold the dbspec text with six
     * fraction digits, binary is bytes and NULL is a null cell. MySQL TIMESTAMP, PostgreSQL timestamptz and timetz, and values
     * outside the dbspec ranges fail with CATALOG_VALUE. Rows hold CatalogGridCell values.
     *
     * @param list<mixed> $params
     */
    public function readOnlyGridQuery(string $sql, array $params = [], int $maxRows = 0, int $maxBytes = 0): CatalogResult
    {
        return $this->readOnly($sql, $params, $maxRows, $maxBytes, true);
    }

    /** @param list<mixed> $params */
    private function readOnly(string $sql, array $params, int $maxRows, int $maxBytes, bool $grid): CatalogResult
    {
        self::validateReadOnly($sql, $this->dialect);
        if ($maxRows < 0 || $maxBytes < 0) {
            throw new OrmException(Code::QUERY_LIMIT_INVALID, 'limits must not be negative');
        }
        $maxRows = $maxRows === 0 ? self::DEFAULT_ROWS : $maxRows;
        $maxBytes = $maxBytes === 0 ? self::DEFAULT_BYTES : $maxBytes;
        $args = [];
        foreach (array_values($params) as $param) {
            $args[] = self::param($param);
        }
        return $this->read(function (\PDO $pdo) use ($sql, $args, $maxRows, $maxBytes, $grid): CatalogResult {
            if ($grid) {
                $raw = $this->gridQuery($pdo, $sql, $args, $maxRows, $maxBytes);
                return new CatalogResult($raw['names'], $raw['rows']);
            }
            $raw = $this->query($pdo, $sql, $args, $maxRows, $maxBytes);
            return new CatalogResult($raw['names'], self::convertRows($raw, $raw['types']));
        });
    }

    /**
     * Inserts one row with explicit primary-key values inside a writable transaction. It rejects an existing key, writes with
     * bound parameters, requires exactly one affected row and re-reads the row by its key before it commits. Every supplied
     * value must read back exactly. Automatic and expression-default keys are not supported and fail when the key is not given.
     *
     * @param array<string, mixed> $values column name => value
     */
    public function insertRow(CatalogTableMetadata $declared, array $values): CatalogResult
    {
        $keyIndexes = self::descriptorKeys($declared);
        $changes = self::changes($declared, $values, Code::ROW_INSERT_INVALID);
        $provided = [];
        foreach ($changes as [$index, $value]) {
            $provided[$index] = $value;
        }
        $keys = [];
        foreach ($keyIndexes as $index) {
            if (!array_key_exists($index, $provided)) {
                throw new OrmException(Code::ROW_INSERT_INVALID,
                    'explicit primary-key value of "' . $declared->columns[$index]->name . '" is required');
            }
            $keys[] = $provided[$index];
        }
        return $this->write(function (\PDO $pdo) use ($declared, $changes, $keys): CatalogResult {
            if ($this->dialect === 'postgres') {
                // The lock that an INSERT takes, held before the schema check so that no DDL changes the table in between.
                $this->exec($pdo, 'LOCK TABLE ' . self::qualified($declared->table, $this->dialect) . ' IN ROW EXCLUSIVE MODE', []);
            }
            if ($this->lookup($pdo, $declared, $keys, true) !== []) {
                throw new OrmException(Code::ROW_CONFLICT, 'insertion key already exists');
            }
            $descriptor = $this->describe($pdo, $declared->table);
            if ($descriptor != $declared) {
                throw new OrmException(Code::ROW_SCHEMA_CHANGED, 'insertion descriptor changed');
            }
            if ($this->dialect === 'mysql') {
                $this->mysqlSafety($pdo, $descriptor);
            }
            $names = [];
            $placeholders = [];
            $args = [];
            foreach ($changes as [$index, $value]) {
                $names[] = self::quote($descriptor->columns[$index]->name, $this->dialect);
                $placeholders[] = '?';
                $args[] = $value;
            }
            $sql = 'INSERT INTO ' . self::qualified($descriptor->table, $this->dialect)
                . ' (' . implode(',', $names) . ') VALUES (' . implode(',', $placeholders) . ')';
            $affected = $this->exec($pdo, $sql, $args);
            if ($affected !== 1) {
                throw new OrmException(Code::ROW_WRITE_MISMATCH, "expected exactly one inserted row, got $affected");
            }
            $after = $this->lookup($pdo, $descriptor, $keys, false);
            if (count($after) !== 1) {
                throw new OrmException(Code::ROW_WRITE_MISMATCH, 'expected exactly one inserted row');
            }
            if ($this->describe($pdo, $declared->table) != $descriptor) {
                throw new OrmException(Code::ROW_SCHEMA_CHANGED, 'insertion descriptor changed');
            }
            foreach ($changes as [$index, $value]) {
                if (self::cellKey($after[0][$index]) !== self::cellKey($value)) {
                    throw new OrmException(Code::ROW_WRITE_MISMATCH,
                        'stored inserted values of "' . $descriptor->columns[$index]->name . '" differ');
                }
            }
            return new CatalogResult(self::columnNames($descriptor), $after);
        });
    }

    /**
     * Updates the row of an original snapshot. Inside the transaction it re-reads the row by its original keys, locks it,
     * compares it with the snapshot and then writes. After the write it re-reads the row by its resulting keys and requires
     * every ordinary column to hold the value that was written. A failed check rolls back.
     *
     * @param array<string, mixed> $values column name => value
     */
    public function updateRow(CatalogRowSnapshot $original, array $values): CatalogResult
    {
        self::validSnapshot($original);
        $changes = self::changes($original->metadata, $values, Code::ROW_UPDATE_INVALID);
        $updated = $original->cells;
        foreach ($changes as [$index, $value]) {
            $updated[$index] = $value;
        }
        try {
            self::checkCells($original->metadata, $updated);
        } catch (OrmException $e) {
            throw new OrmException(Code::ROW_UPDATE_INVALID, 'invalid updated row: ' . $e->getMessage(), $e);
        }
        try {
            self::revision($original->metadata, $updated);
        } catch (OrmException $e) {
            throw new OrmException(Code::ROW_UPDATE_LIMIT, 'updated row budget exceeded: ' . $e->getMessage(), $e);
        }
        $keys = self::keysOf($original);
        $newKeys = [];
        foreach ($original->keyIndexes as $index) {
            $newKeys[] = $updated[$index];
        }
        return $this->write(function (\PDO $pdo) use ($original, $changes, $updated, $keys, $newKeys): CatalogResult {
            $current = $this->lookup($pdo, $original->metadata, $keys, true);
            $descriptor = $this->describe($pdo, $original->metadata->table);
            if ($descriptor != $original->metadata) {
                throw new OrmException(Code::ROW_SCHEMA_CHANGED, 'original descriptor changed');
            }
            self::checkCurrent($current, $original->cells);
            if ($this->dialect === 'mysql') {
                $this->mysqlSafety($pdo, $descriptor);
            }
            $sets = [];
            $args = [];
            foreach ($changes as [$index, $value]) {
                $sets[] = self::quote($descriptor->columns[$index]->name, $this->dialect) . '=?';
                $args[] = $value;
            }
            foreach ($keys as $key) {
                $args[] = $key;
            }
            $sql = 'UPDATE ' . self::qualified($descriptor->table, $this->dialect) . ' SET ' . implode(',', $sets)
                . ' WHERE ' . $this->keyPredicate($descriptor);
            $affected = $this->exec($pdo, $sql, $args);
            // MySQL reports the matched rows here, and an update that changes nothing still matches its row.
            if ($affected > 1 || ($affected === 0 && $this->dialect !== 'mysql')) {
                throw new OrmException(Code::ROW_WRITE_MISMATCH, "unexpected affected row count $affected");
            }
            $after = $this->lookup($pdo, $descriptor, $newKeys, false);
            if (count($after) !== 1) {
                throw new OrmException(Code::ROW_WRITE_MISMATCH, 'expected exactly one updated row, got ' . count($after));
            }
            if ($this->describe($pdo, $original->metadata->table) != $descriptor) {
                throw new OrmException(Code::ROW_SCHEMA_CHANGED, 'original descriptor changed');
            }
            foreach ($descriptor->columns as $i => $column) {
                if ($column->generated) {
                    // A generated column may be recomputed by the database.
                    continue;
                }
                if (self::cellKey($after[0][$i]) !== self::cellKey($updated[$i])) {
                    throw new OrmException(Code::ROW_WRITE_MISMATCH, 'stored ordinary values of "' . $column->name . '" differ');
                }
            }
            return new CatalogResult(self::columnNames($descriptor), $after);
        });
    }

    /**
     * Deletes the row of an original snapshot. Inside the transaction it locks and compares the row, requires exactly one
     * affected row and verifies that no row remains under the key. It returns the number of rows deleted.
     */
    public function deleteRow(CatalogRowSnapshot $original): int
    {
        self::validSnapshot($original);
        $keys = self::keysOf($original);
        return $this->write(function (\PDO $pdo) use ($original, $keys): int {
            $current = $this->lookup($pdo, $original->metadata, $keys, true);
            $descriptor = $this->describe($pdo, $original->metadata->table);
            if ($descriptor != $original->metadata) {
                throw new OrmException(Code::ROW_SCHEMA_CHANGED, 'original descriptor changed');
            }
            self::checkCurrent($current, $original->cells);
            if ($this->dialect === 'mysql') {
                $this->mysqlSafety($pdo, $descriptor);
            }
            $sql = 'DELETE FROM ' . self::qualified($descriptor->table, $this->dialect) . ' WHERE ' . $this->keyPredicate($descriptor);
            $affected = $this->exec($pdo, $sql, $keys);
            if ($affected !== 1) {
                throw new OrmException(Code::ROW_WRITE_MISMATCH, "expected exactly one deleted row, got $affected");
            }
            if ($this->lookup($pdo, $descriptor, $keys, false) !== []) {
                throw new OrmException(Code::ROW_WRITE_MISMATCH, 'deleted row remains');
            }
            if ($this->describe($pdo, $original->metadata->table) != $descriptor) {
                throw new OrmException(Code::ROW_SCHEMA_CHANGED, 'original descriptor changed');
            }
            return $affected;
        });
    }

    /**
     * Runs a bounded query and types each cell by the native type of its column (gridCell). SQLite types each value, so its
     * cells take the type of their own value.
     *
     * @param list<mixed> $args
     * @return array{names: list<string>, rows: list<list<CatalogGridCell>>}
     */
    private function gridQuery(\PDO $pdo, string $sql, array $args, int $maxRows, int $maxBytes): array
    {
        try {
            $st = $pdo->prepare($sql);
            $st->execute($args);
            $names = [];
            $columns = [];
            for ($i = 0, $n = $st->columnCount(); $i < $n; $i++) {
                $meta = $st->getColumnMeta($i) ?: [];
                $name = (string) ($meta['name'] ?? '');
                $names[] = $name;
                $native = strtoupper((string) ($meta['native_type'] ?? ''));
                $unsigned = false;
                $binary = false;
                if ($this->dialect === 'mysql' && (in_array($native, self::MYSQL_INTEGER_TYPES, true)
                    || in_array($native, self::MYSQL_STRING_TYPES, true))) {
                    // PDO reports neither the UNSIGNED flag nor the binary charset, so both come from the column definition of
                    // the table. An expression has no column definition, and its type is refused rather than guessed.
                    $table = (string) ($meta['table'] ?? '');
                    if ($table === '') {
                        throw self::refused("expression \"$name\" of type $native has no column definition, so PDO does not report its signedness or charset; select a table column");
                    }
                    [$dataType, $columnType] = $this->mysqlColumnDefinition($pdo, $table, $name);
                    $unsigned = str_contains($columnType, 'unsigned');
                    $binary = in_array($dataType, ['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob'], true);
                }
                $columns[] = [$native, $unsigned, $binary];
            }
            $rows = [];
            $budget = 0;
            while (($row = $st->fetch(\PDO::FETCH_NUM)) !== false) {
                if (count($rows) === $maxRows) {
                    throw new OrmException(Code::CATALOG_LIMIT, "result has more than $maxRows rows");
                }
                foreach ($row as $value) {
                    $budget += is_string($value) ? strlen($value) : 8;
                }
                if ($budget > $maxBytes) {
                    throw new OrmException(Code::CATALOG_LIMIT, "result has more than $maxBytes bytes of values");
                }
                $cells = [];
                foreach ($row as $i => $value) {
                    [$native, $unsigned, $binary] = $columns[$i];
                    if ($this->dialect === 'sqlite') {
                        // SQLite types each value: PDO reports the type of this row's value, and a blob with the flag blob.
                        $cellMeta = $st->getColumnMeta($i) ?: [];
                        $native = strtoupper((string) ($cellMeta['native_type'] ?? ''));
                        $binary = in_array('blob', (array) ($cellMeta['flags'] ?? []), true);
                    }
                    $cells[] = self::gridCell($value, $this->dialect, $native, $unsigned, $binary);
                }
                $rows[] = $cells;
            }
            return ['names' => $names, 'rows' => $rows];
        } catch (\PDOException $e) {
            throw $this->db->driverError($e);
        }
    }

    /**
     * The grid cell of one driver value. native is the upper-cased type name that PDO reports for the column (MySQL field
     * type names, PostgreSQL type names); unsigned is a MySQL UNSIGNED column and binary a binary string.
     */
    private static function gridCell(mixed $value, string $dialect, string $native, bool $unsigned, bool $binary): CatalogGridCell
    {
        if ($value === null) {
            return new CatalogGridCell('null');
        }
        if ($dialect === 'mysql') {
            switch ($native) {
                case 'FLOAT':
                    return self::float32Cell($value);
                case 'DOUBLE':
                    return self::float64Cell($value);
                case 'TIMESTAMP':
                    throw self::refused('MySQL TIMESTAMP follows a time zone');
                case 'DATE':
                    return new CatalogGridCell('date', self::dateText(self::gridText($value)));
                case 'DATETIME':
                    return new CatalogGridCell('datetime', self::dateTimeText(self::gridText($value)));
                case 'TIME':
                    return new CatalogGridCell('time', self::timeText(self::gridText($value)));
                case 'DECIMAL':
                case 'NEWDECIMAL':
                    return new CatalogGridCell('decimal', self::gridText($value));
                case 'LONG':
                case 'LONGLONG':
                case 'SHORT':
                case 'TINY':
                case 'INT24':
                case 'YEAR':
                    return self::integerCell($value, $unsigned);
            }
        }
        if ($dialect === 'postgres') {
            switch ($native) {
                case 'FLOAT4':
                    return self::float32Cell($value);
                case 'FLOAT8':
                    return self::float64Cell($value);
                case 'NUMERIC':
                    return new CatalogGridCell('decimal', self::gridText($value));
                case 'TIMESTAMPTZ':
                case 'TIMETZ':
                    throw self::refused("PostgreSQL $native is unsupported");
                case 'DATE':
                    return new CatalogGridCell('date', self::dateText(self::gridText($value)));
                case 'TIME':
                    return new CatalogGridCell('time', self::timeText(self::gridText($value)));
                case 'TIMESTAMP':
                    return new CatalogGridCell('datetime', self::dateTimeText(self::gridText($value)));
                case 'INT2':
                case 'INT4':
                case 'INT8':
                    return self::integerCell($value, false);
                case 'BYTEA':
                    return new CatalogGridCell('binary', self::bytes($value));
            }
        }
        if (is_bool($value)) {
            return new CatalogGridCell('boolean', $value);
        }
        if (is_int($value)) {
            return self::integerCell($value, $unsigned);
        }
        if (is_float($value)) {
            return self::float64Cell($value);
        }
        if (is_resource($value) || ($binary && is_string($value))) {
            return new CatalogGridCell('binary', self::bytes($value));
        }
        if (is_string($value)) {
            if (!self::isUtf8($value)) {
                throw new OrmException(Code::CATALOG_VALUE, 'unsupported grid value: text of native type "' . $native . '" is not valid UTF-8');
            }
            return new CatalogGridCell('text', $value);
        }
        throw self::refused('native type ' . get_debug_type($value) . " of column type \"$native\"");
    }

    /** The bytes of a binary value. PDO reads a PostgreSQL bytea as a stream, which is read to its end here. */
    private static function bytes(mixed $value): string
    {
        if (is_string($value)) {
            return $value;
        }
        if (!is_resource($value)) {
            throw self::refused('expected binary data, got ' . get_debug_type($value));
        }
        $data = stream_get_contents($value);
        fclose($value);
        if ($data === false) {
            throw self::refused('binary stream could not be read');
        }
        return $data;
    }

    /**
     * The data type and the column type (with its UNSIGNED flag) of a MySQL column of a table in the current database.
     *
     * @return array{0: string, 1: string}
     */
    private function mysqlColumnDefinition(\PDO $pdo, string $table, string $column): array
    {
        $rows = $this->query($pdo,
            'SELECT DATA_TYPE, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
            [$table, $column], 2, self::METADATA_BYTES)['rows'];
        if (count($rows) !== 1 || !is_string($rows[0][0] ?? null) || !is_string($rows[0][1] ?? null)) {
            throw self::refused("column \"$table.$column\" has no single column definition in the current database");
        }
        return [strtolower($rows[0][0]), strtolower($rows[0][1])];
    }

    private static function refused(string $message): OrmException
    {
        return new OrmException(Code::CATALOG_VALUE, "unsupported grid value: $message");
    }

    private static function gridText(mixed $value): string
    {
        if (!is_string($value)) {
            throw self::refused('expected text, got ' . get_debug_type($value));
        }
        return $value;
    }

    /** A float32 cell: the bits of the single-precision value, as eight lowercase hexadecimal digits. */
    private static function float32Cell(mixed $value): CatalogGridCell
    {
        return new CatalogGridCell('float32', bin2hex(pack('G', self::floatValue($value))));
    }

    /** A float64 cell: the bits of the double-precision value, as sixteen lowercase hexadecimal digits. */
    private static function float64Cell(mixed $value): CatalogGridCell
    {
        return new CatalogGridCell('float64', bin2hex(pack('E', self::floatValue($value))));
    }

    private static function floatValue(mixed $value): float
    {
        if (is_float($value)) {
            return $value;
        }
        if (is_int($value)) {
            return (float) $value;
        }
        if (is_string($value) && is_numeric($value)) {
            return (float) $value;
        }
        throw self::refused('expected a number, got ' . get_debug_type($value));
    }

    /** An integer cell; an UNSIGNED column holds its value as exact decimal digits, which PHP ints cannot hold past PHP_INT_MAX. */
    private static function integerCell(mixed $value, bool $unsigned): CatalogGridCell
    {
        if (is_int($value)) {
            return $unsigned ? new CatalogGridCell('unsigned', sprintf('%u', $value)) : new CatalogGridCell('integer', $value);
        }
        if (!is_string($value)) {
            throw self::refused('expected an integer, got ' . get_debug_type($value));
        }
        if ($unsigned) {
            if (preg_match('/^\d+$/', $value) !== 1) {
                throw self::refused("unsigned integer text \"$value\"");
            }
            return new CatalogGridCell('unsigned', $value);
        }
        $n = filter_var($value, FILTER_VALIDATE_INT);
        if ($n === false) {
            throw self::refused("integer text \"$value\" is outside the signed 64-bit range");
        }
        return new CatalogGridCell('integer', $n);
    }

    /** A dbspec date, YYYY-MM-DD: a calendar date from 0001-01-01 to 9999-12-31. */
    private static function dateText(string $text): string
    {
        if (preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $text, $m) !== 1 || (int) $m[1] < 1
            || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
            throw self::refused("date \"$text\" is outside 0001-01-01 to 9999-12-31 or is not a date");
        }
        return $text;
    }

    /** A dbspec time, HH:MM:SS.ffffff: a time of day from 00:00:00 to 23:59:59.999999. */
    private static function timeText(string $text): string
    {
        if (preg_match('/^(\d{2,3}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/', $text, $m) !== 1) {
            throw self::refused("time \"$text\" is not a time of day");
        }
        if ((int) $m[1] > 23 || (int) $m[2] > 59 || (int) $m[3] > 59) {
            throw self::refused('time outside 00:00:00 to 23:59:59.999999');
        }
        return sprintf('%02d:%02d:%02d.%s', (int) $m[1], (int) $m[2], (int) $m[3], str_pad($m[4] ?? '', 6, '0'));
    }

    /** A dbspec datetime, YYYY-MM-DD HH:MM:SS.ffffff, in UTC. */
    private static function dateTimeText(string $text): string
    {
        $space = strpos($text, ' ');
        if ($space === false) {
            throw self::refused("datetime \"$text\" has no date and time");
        }
        return self::dateText(substr($text, 0, $space)) . ' ' . self::timeText(substr($text, $space + 1));
    }

    /**
     * Runs fn in a read-only session and ends it with ROLLBACK.
     *
     * @template T
     * @param \Closure(\PDO): T $fn
     * @return T
     */
    private function read(\Closure $fn): mixed
    {
        return $this->session(true, $fn);
    }

    /**
     * Runs fn in a writable transaction. A failed fn rolls back. A commit that the database rejects rolls back and reports
     * ROW_COMMIT_REJECTED; any other commit failure is an unknown outcome that must not be retried.
     *
     * @template T
     * @param \Closure(\PDO): T $fn
     * @return T
     */
    private function write(\Closure $fn): mixed
    {
        return $this->session(false, $fn);
    }

    /**
     * Opens one transaction on the connection, runs fn and ends the transaction. SQLite sets query_only on every session
     * itself, so a read session cannot write and a write session is not left read-only.
     *
     * @template T
     * @param \Closure(\PDO): T $fn
     * @return T
     */
    private function session(bool $readOnly, \Closure $fn): mixed
    {
        $pdo = $this->db->pdo();
        try {
            if ($this->dialect === 'sqlite') {
                $pdo->exec('PRAGMA query_only = ' . ($readOnly ? 'ON' : 'OFF'));
            }
            $pdo->exec(self::beginSql($this->dialect, $readOnly));
        } catch (\PDOException $e) {
            throw $this->db->driverError($e);
        }
        try {
            $value = $fn($pdo);
        } catch (\Throwable $cause) {
            $this->rollback($pdo, $cause);
        }
        if ($readOnly) {
            $this->endRead($pdo);
            return $value;
        }
        try {
            $pdo->exec('COMMIT');
        } catch (\PDOException $e) {
            $this->commitFailed($pdo, $e);
        }
        return $value;
    }

    /** Rolls the transaction back and rethrows cause; a failed rollback is reported with cause as its previous error. */
    private function rollback(\PDO $pdo, \Throwable $cause): never
    {
        try {
            $pdo->exec('ROLLBACK');
        } catch (\PDOException $e) {
            throw OrmException::rollback($cause, $this->db->driverError($e));
        }
        throw $cause;
    }

    private function endRead(\PDO $pdo): void
    {
        try {
            $pdo->exec('ROLLBACK');
        } catch (\PDOException $e) {
            throw new OrmException(Code::ROW_ROLLBACK_FAILED, 'rollback: ' . $this->db->driverError($e)->getMessage(), $e);
        }
    }

    /** Reports a rejected or unknown commit. The rejected commit rolls back; an unknown outcome is never retried. */
    private function commitFailed(\PDO $pdo, \PDOException $e): never
    {
        $mapped = $this->db->driverError($e);
        if (in_array($mapped->code_, [Code::DUPLICATE_KEY, Code::FOREIGN_KEY, Code::CONSTRAINT, Code::DEADLOCK], true)) {
            $this->rollback($pdo, new OrmException(Code::ROW_COMMIT_REJECTED,
                'native commit rejected: ' . $mapped->getMessage(), $mapped));
        }
        // The outcome is unknown. Ending the server transaction is the discard of the connection that the Go client does.
        // Whether that ROLLBACK succeeds does not change the outcome, which is reported as unknown: a failed ROLLBACK is
        // reported with it, as the cause of the indeterminate error.
        $message = 'commit outcome unknown; do not retry: ' . $mapped->getMessage();
        $cause = $mapped;
        try {
            $pdo->exec('ROLLBACK');
        } catch (\PDOException $rollbackFailure) {
            $cause = $this->db->driverError($rollbackFailure);
            $message .= '; rollback failed: ' . $cause->getMessage();
        }
        throw new OrmException(Code::ROW_COMMIT_INDETERMINATE, $message, $cause);
    }

    private static function beginSql(string $dialect, bool $readOnly): string
    {
        return match (true) {
            $dialect === 'mysql' => $readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION',
            $dialect === 'postgres' => $readOnly ? 'BEGIN READ ONLY' : 'BEGIN',
            $readOnly => 'BEGIN',
            default => 'BEGIN IMMEDIATE',
        };
    }

    /**
     * Runs a bounded query. It fails when the result has more than maxRows rows or more than maxBytes of values.
     *
     * @param list<mixed> $args
     * @return array{names: list<string>, types: list<string>, rows: list<list<mixed>>}
     */
    private function query(\PDO $pdo, string $sql, array $args, int $maxRows, int $maxBytes): array
    {
        try {
            $st = $pdo->prepare($sql);
            $st->execute($args);
            $names = [];
            $types = [];
            for ($i = 0, $n = $st->columnCount(); $i < $n; $i++) {
                $meta = $st->getColumnMeta($i);
                $names[] = (string) ($meta['name'] ?? '');
                $types[] = strtoupper((string) ($meta['native_type'] ?? ''));
            }
            $rows = [];
            $budget = 0;
            while (($row = $st->fetch(\PDO::FETCH_NUM)) !== false) {
                if (count($rows) === $maxRows) {
                    throw new OrmException(Code::CATALOG_LIMIT, "result has more than $maxRows rows");
                }
                foreach ($row as $value) {
                    $budget += is_string($value) ? strlen($value) : 8;
                }
                if ($budget > $maxBytes) {
                    throw new OrmException(Code::CATALOG_LIMIT, "result has more than $maxBytes bytes of values");
                }
                $rows[] = $row;
            }
            return ['names' => $names, 'types' => $types, 'rows' => $rows];
        } catch (\PDOException $e) {
            throw $this->db->driverError($e);
        }
    }

    /** @param list<mixed> $args Runs one statement and returns the number of rows it affected. */
    private function exec(\PDO $pdo, string $sql, array $args): int
    {
        try {
            $st = $pdo->prepare($sql);
            $st->execute($args);
            return $st->rowCount();
        } catch (\PDOException $e) {
            throw $this->db->driverError($e);
        }
    }

    /**
     * Describes a table inside the session. Callers that need a stable descriptor describe it again inside the same session
     * and compare the two.
     *
     * @param array{namespace: string, name: string} $ref
     */
    private function describe(\PDO $pdo, array $ref): CatalogTableMetadata
    {
        if ($this->dialect === 'sqlite' && $ref['namespace'] !== 'main') {
            throw new OrmException(Code::TABLE_NAMESPACE_UNSUPPORTED, 'SQLite requires main');
        }
        $kindRaw = $this->query($pdo, self::KIND_SQL[$this->dialect], [$ref['namespace'], $ref['name']], 2, self::METADATA_BYTES);
        if ($kindRaw['rows'] === []) {
            throw new OrmException(Code::TABLE_NOT_FOUND, $ref['namespace'] . '.' . $ref['name']);
        }
        if (count($kindRaw['rows']) !== 1 || count($kindRaw['rows'][0]) !== 1) {
            throw new OrmException(Code::TABLE_METADATA_INVALID, 'ambiguous relation');
        }
        $kind = self::kind($this->dialect, self::text($kindRaw['rows'][0][0]));

        // SQLite table-valued pragmas take the table name first and the schema second.
        $args = $this->dialect === 'sqlite' ? [$ref['name'], $ref['namespace']] : [$ref['namespace'], $ref['name']];
        $raw = $this->query($pdo, self::COLUMNS_SQL[$this->dialect], $args, self::METADATA_ROWS, self::METADATA_BYTES);

        $columns = [];
        $keys = [];
        foreach ($raw['rows'] as $row) {
            if (count($row) !== 8) {
                throw new OrmException(Code::TABLE_METADATA_INVALID, 'column shape of ' . count($row) . ' values');
            }
            $column = self::columnRow($row);
            foreach ($columns as $existing) {
                if ($existing->name === $column->name) {
                    throw new OrmException(Code::TABLE_METADATA_INVALID, "duplicate column \"$column->name\"");
                }
            }
            $ordinal = self::intValue($row[4]);
            if ($ordinal < 0) {
                throw new OrmException(Code::TABLE_METADATA_INVALID, 'negative key ordinal');
            }
            if ($ordinal > 0) {
                $keys[] = [$ordinal, count($columns)];
            }
            $columns[] = $column;
        }
        usort($keys, static fn (array $a, array $b): int => $a[0] <=> $b[0]);
        foreach ($keys as $i => $key) {
            if ($key[0] !== $i + 1) {
                throw new OrmException(Code::TABLE_METADATA_INVALID, 'key order');
            }
        }

        // A SQLite INTEGER primary key without a separate primary-key index is the rowid alias: never NULL, generated by the database.
        if ($this->dialect === 'sqlite' && $kind === 'table' && count($keys) === 1
            && strcasecmp($columns[$keys[0][1]]->nativeType, 'INTEGER') === 0) {
            $indexRaw = $this->query($pdo, "SELECT count(*) FROM pragma_index_list(?,?) WHERE origin='pk'", $args, 1, self::METADATA_BYTES);
            if (count($indexRaw['rows']) !== 1 || count($indexRaw['rows'][0]) !== 1) {
                throw new OrmException(Code::TABLE_METADATA_INVALID, 'primary index count');
            }
            if (self::intValue($indexRaw['rows'][0][0]) === 0) {
                $old = $columns[$keys[0][1]];
                $columns[$keys[0][1]] = new CatalogColumn($old->name, $old->nativeType, false, $old->generated,
                    true, $old->defaultExpression, $old->expressionDefault);
            }
        }

        $reliable = in_array($kind, ['table', 'partitioned'], true) && $keys !== [];
        $primaryKey = [];
        foreach ($keys as [, $index]) {
            $column = $columns[$index];
            if ($column->nullable) {
                $reliable = false;
            }
            $primaryKey[] = $column->name;
        }
        return new CatalogTableMetadata($ref, $kind, $columns, $primaryKey, $reliable);
    }

    /** Checks the names of a table reference and returns it as {namespace, name}. */
    private static function tableRef(array $table): array
    {
        $namespace = $table['namespace'] ?? null;
        $name = $table['name'] ?? null;
        if (count($table) !== 2 || !is_string($namespace) || !is_string($name)) {
            throw new OrmException(Code::TABLE_REFERENCE_INVALID, 'a table is {namespace, name}');
        }
        self::checkName($namespace);
        self::checkName($name);
        return ['namespace' => $namespace, 'name' => $name];
    }

    /** Accepts a namespace, table or column name of 1..1024 UTF-8 bytes without NUL. */
    private static function checkName(string $name): void
    {
        if ($name === '' || strlen($name) > 1024 || str_contains($name, "\0") || !self::isUtf8($name)) {
            throw new OrmException(Code::TABLE_REFERENCE_INVALID, 'expected 1..1024 UTF-8 bytes without NUL');
        }
    }

    private static function isUtf8(string $value): bool
    {
        return preg_match('//u', $value) === 1;
    }

    /** Quotes an identifier of the dialect, doubling the quote mark inside it. */
    private static function quote(string $name, string $dialect): string
    {
        $mark = $dialect === 'mysql' ? '`' : '"';
        return $mark . str_replace($mark, $mark . $mark, $name) . $mark;
    }

    /** @param list<string> $names */
    private static function quoteList(array $names, string $dialect): string
    {
        return implode(',', array_map(static fn (string $name): string => self::quote($name, $dialect), $names));
    }

    /** @param array{namespace: string, name: string} $ref */
    private static function qualified(array $ref, string $dialect): string
    {
        return self::quote($ref['namespace'], $dialect) . '.' . self::quote($ref['name'], $dialect);
    }

    /** The predicate of the primary key: each key column equals one placeholder. */
    private function keyPredicate(CatalogTableMetadata $metadata): string
    {
        return implode(' AND ', array_map(fn (string $name): string => self::quote($name, $this->dialect) . '=?', $metadata->primaryKey));
    }

    private static function kind(string $dialect, string $native): string
    {
        return match (true) {
            $dialect === 'mysql' && $native === 'BASE TABLE', $dialect === 'postgres' && $native === 'r',
            $dialect === 'sqlite' && $native === 'table' => 'table',
            $dialect === 'mysql' && ($native === 'VIEW' || $native === 'SYSTEM VIEW'),
            $dialect === 'postgres' && $native === 'v', $dialect === 'sqlite' && $native === 'view' => 'view',
            $dialect === 'postgres' && $native === 'p' => 'partitioned',
            $dialect === 'postgres' && $native === 'm' => 'materialized_view',
            $dialect === 'postgres' && $native === 'f' => 'foreign',
            $dialect === 'sqlite' && $native === 'virtual' => 'virtual',
            $dialect === 'sqlite' && $native === 'shadow' => 'shadow',
            default => throw new OrmException(Code::TABLE_KIND_UNSUPPORTED, "relation kind $native of $dialect"),
        };
    }

    /** @param array<int, mixed> $row */
    private static function columnRow(array $row): CatalogColumn
    {
        $name = self::text($row[0]);
        self::checkName($name);
        $native = self::text($row[1]);
        if ($row[6] !== null && !is_string($row[6])) {
            throw new OrmException(Code::TABLE_METADATA_INVALID, "default expression of column \"$name\" is " . get_debug_type($row[6]));
        }
        return new CatalogColumn($name, $native, self::boolValue($row[2]), self::boolValue($row[3]),
            self::boolValue($row[5]), $row[6], self::boolValue($row[7]));
    }

    private static function text(mixed $value): string
    {
        if (!is_string($value)) {
            throw new OrmException(Code::TABLE_METADATA_INVALID, 'expected text, got ' . get_debug_type($value));
        }
        return $value;
    }

    /** A boolean of a metadata row: a native boolean, or integer or text 0 and 1. */
    private static function boolValue(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if ($value === 0 || $value === 1 || $value === '0' || $value === '1') {
            return $value === 1 || $value === '1';
        }
        throw new OrmException(Code::TABLE_METADATA_INVALID, 'expected a boolean, got ' . var_export($value, true));
    }

    /** An integer of a metadata row: a native integer, or text that holds one. */
    private static function intValue(mixed $value): int
    {
        $n = is_string($value) ? filter_var($value, FILTER_VALIDATE_INT) : $value;
        if (!is_int($n)) {
            throw new OrmException(Code::TABLE_METADATA_INVALID, 'expected an integer, got ' . get_debug_type($value));
        }
        return $n;
    }

    /** @return list<string> */
    private static function columnNames(CatalogTableMetadata $metadata): array
    {
        return array_map(static fn (CatalogColumn $column): string => $column->name, $metadata->columns);
    }

    /** @return list<string> */
    private static function nativeTypes(CatalogTableMetadata $metadata): array
    {
        return array_map(static fn (CatalogColumn $column): string => $column->nativeType, $metadata->columns);
    }

    /** @param list<string> $names */
    private static function sameNames(array $names, CatalogTableMetadata $metadata, string $code): void
    {
        if ($names !== self::columnNames($metadata)) {
            throw new OrmException($code, 'prepared columns differ from descriptor');
        }
    }

    /**
     * Converts the values of a raw result with the native type of each column. Text is a string, binary the bytes, integers
     * int, floats float, and decimals their plain text. A value that its type does not fit fails explicitly.
     *
     * @param array{names: list<string>, types: list<string>, rows: list<list<mixed>>} $raw
     * @param list<string> $types
     * @return list<list<mixed>>
     */
    private static function convertRows(array $raw, array $types): array
    {
        if (count($types) !== count($raw['names'])) {
            throw new OrmException(Code::TABLE_METADATA_INVALID, count($types) . ' native types for ' . count($raw['names']) . ' columns');
        }
        $out = [];
        foreach ($raw['rows'] as $row) {
            $converted = [];
            foreach ($row as $i => $value) {
                $converted[] = self::value($value, $types[$i]);
            }
            $out[] = $converted;
        }
        return $out;
    }

    private static function value(mixed $value, string $nativeType): mixed
    {
        if ($value === null || is_bool($value) || is_int($value) || is_float($value)) {
            return $value;
        }
        if (!is_string($value)) {
            throw new OrmException(Code::CATALOG_VALUE, 'unsupported driver value ' . get_debug_type($value));
        }
        return match (self::typeClass($nativeType)) {
            'binary', 'decimal' => $value,
            'int' => filter_var($value, FILTER_VALIDATE_INT) !== false
                ? (int) $value
                : throw new OrmException(Code::CATALOG_VALUE, "integer of native type \"$nativeType\""),
            'float' => is_numeric($value)
                ? (float) $value
                : throw new OrmException(Code::CATALOG_VALUE, "float of native type \"$nativeType\""),
            default => self::isUtf8($value)
                ? $value
                : throw new OrmException(Code::CATALOG_VALUE, "text of native type \"$nativeType\" is not valid UTF-8"),
        };
    }

    /** The class of a native type: the driver's type names of a result and the declared type text of a descriptor. */
    private static function typeClass(string $nativeType): string
    {
        $type = strtoupper($nativeType);
        if (in_array($type, ['LONG', 'LONGLONG', 'SHORT', 'TINY', 'INT24', 'YEAR'], true)) {
            return 'int';
        }
        if (in_array($type, ['DOUBLE', 'FLOAT'], true)) {
            return 'float';
        }
        if ($type === 'NEWDECIMAL') {
            return 'decimal';
        }
        if (preg_match('/BLOB|BINARY|BYTEA/', $type) === 1) {
            return 'binary';
        }
        if (preg_match('/DECIMAL|NUMERIC|MONEY/', $type) === 1) {
            return 'decimal';
        }
        if (str_contains($type, 'INT') && !str_contains($type, 'POINT')) {
            return 'int';
        }
        if (preg_match('/FLOAT|DOUBLE|REAL/', $type) === 1) {
            return 'float';
        }
        return 'text';
    }

    /** Checks a bound parameter and returns it. Only null, bool, int, text and finite float are bound. */
    private static function param(mixed $value): mixed
    {
        if ($value === null || is_bool($value) || is_int($value) || is_string($value)) {
            return $value;
        }
        if (is_float($value)) {
            if (!is_finite($value)) {
                throw new OrmException(Code::CATALOG_PARAM, 'parameter is not finite');
            }
            return $value;
        }
        throw new OrmException(Code::CATALOG_PARAM, 'parameter has unsupported type ' . get_debug_type($value));
    }

    /**
     * Checks named assignments against a descriptor and returns [column index, normalized value] in the order given. Unknown,
     * duplicate and generated columns, a NULL in a non-null column and unsupported values fail before any statement runs.
     *
     * @param array<string, mixed> $values
     * @return list<array{0: int, 1: mixed}>
     */
    private static function changes(CatalogTableMetadata $metadata, array $values, string $code): array
    {
        if ($values === [] || count($values) > count($metadata->columns)) {
            throw new OrmException($code, 'invalid column assignments');
        }
        $normalized = [];
        foreach ($values as $name => $value) {
            $normalized[] = [(string) $name, self::param($value)];
        }
        $changes = [];
        foreach ($normalized as [$name, $value]) {
            $index = self::indexOf($metadata, $name);
            if ($index < 0) {
                throw new OrmException($code, "unknown column \"$name\"");
            }
            $column = $metadata->columns[$index];
            if ($column->generated) {
                throw new OrmException($code, "generated column \"$name\" is not writable");
            }
            if ($value === null && !$column->nullable) {
                throw new OrmException($code, "NULL in non-null column \"$name\"");
            }
            $changes[] = [$index, $value];
        }
        return $changes;
    }

    /** The position of the named column in the descriptor, or -1. */
    private static function indexOf(CatalogTableMetadata $metadata, string $name): int
    {
        foreach ($metadata->columns as $i => $column) {
            if ($column->name === $name) {
                return $i;
            }
        }
        return -1;
    }

    /**
     * Checks that a descriptor has a reliable row identity and returns the column index of each primary-key column in
     * constraint order.
     *
     * @return list<int>
     */
    private static function descriptorKeys(CatalogTableMetadata $metadata): array
    {
        $invalid = static fn (string $reason): OrmException
            => new OrmException(Code::ROW_SNAPSHOT_INVALID, "invalid original row or descriptor: $reason");
        if (!in_array($metadata->kind, ['table', 'partitioned'], true)) {
            throw $invalid('the relation is not a table');
        }
        if (!$metadata->reliableRowIdentity || $metadata->primaryKey === [] || $metadata->columns === []
            || count($metadata->columns) > 2048) {
            throw $invalid('no reliable row identity');
        }
        $names = [];
        foreach ($metadata->columns as $column) {
            try {
                self::checkName($column->name);
            } catch (OrmException $e) {
                throw $invalid($e->getMessage());
            }
            if (isset($names[$column->name]) || str_contains($column->nativeType, "\0")) {
                throw $invalid('duplicate column or invalid native type');
            }
            $names[$column->name] = true;
        }
        $keys = [];
        $indexes = [];
        foreach ($metadata->primaryKey as $key) {
            if (isset($keys[$key])) {
                throw $invalid('duplicate key column');
            }
            $keys[$key] = true;
            $index = self::indexOf($metadata, $key);
            if ($index < 0 || $metadata->columns[$index]->nullable) {
                throw $invalid('key column is missing or nullable');
            }
            $indexes[] = $index;
        }
        return $indexes;
    }

    /** Checks a snapshot was captured by rowSnapshotFromPage: it has key positions and one cell per column. */
    private static function validSnapshot(CatalogRowSnapshot $snapshot): void
    {
        if ($snapshot->keyIndexes === [] || count($snapshot->cells) !== count($snapshot->metadata->columns)) {
            throw new OrmException(Code::ROW_SNAPSHOT_INVALID, 'the snapshot was not captured by rowSnapshotFromPage');
        }
    }

    /** The primary-key cells of a snapshot in constraint order. @return list<mixed> */
    private static function keysOf(CatalogRowSnapshot $snapshot): array
    {
        return array_map(static fn (int $index): mixed => $snapshot->cells[$index], $snapshot->keyIndexes);
    }

    /**
     * Checks a row against its descriptor: one cell per column, no NULL in a non-null column and only supported values.
     *
     * @param list<mixed> $cells
     */
    private static function checkCells(CatalogTableMetadata $metadata, array $cells): void
    {
        if (count($cells) !== count($metadata->columns)) {
            throw new OrmException(Code::ROW_SNAPSHOT_INVALID,
                'row has ' . count($cells) . ' cells for ' . count($metadata->columns) . ' columns');
        }
        foreach ($cells as $i => $cell) {
            if ($cell === null && !$metadata->columns[$i]->nullable) {
                throw new OrmException(Code::ROW_SNAPSHOT_INVALID, 'NULL in non-null column "' . $metadata->columns[$i]->name . '"');
            }
            self::cellKey($cell);
        }
    }

    /**
     * The canonical text of one cell: its type and its exact value. Two cells are equal exactly when their keys are equal, so
     * a float compares by its bits.
     */
    private static function cellKey(mixed $cell): string
    {
        if ($cell === null) {
            return 'n';
        }
        if (is_bool($cell)) {
            return $cell ? 'b1' : 'b0';
        }
        if (is_int($cell)) {
            return 'i' . $cell;
        }
        if (is_float($cell)) {
            if (!is_finite($cell)) {
                throw new OrmException(Code::ROW_SNAPSHOT_INVALID, 'non-finite float cell');
            }
            return 'f' . bin2hex(pack('E', $cell));
        }
        if (is_string($cell)) {
            return 's' . strlen($cell) . ':' . $cell;
        }
        throw new OrmException(Code::ROW_SNAPSHOT_INVALID, 'unsupported cell type ' . get_debug_type($cell));
    }

    /**
     * The SHA-256 revision of a descriptor and a row, bounded by SNAPSHOT_BYTES.
     *
     * @param list<mixed> $cells
     */
    private static function revision(CatalogTableMetadata $metadata, array $cells): string
    {
        $keys = array_map(self::cellKey(...), $cells);
        try {
            $encoded = json_encode(['orm-catalog-row-v1', $metadata, $keys], JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            throw new OrmException(Code::ROW_SNAPSHOT_INVALID, 'descriptor encoding: ' . $e->getMessage(), $e);
        }
        if (strlen($encoded) > self::SNAPSHOT_BYTES) {
            throw new OrmException(Code::ROW_SNAPSHOT_LIMIT, 'original row encoding exceeds its budget');
        }
        return hash('sha256', $encoded);
    }

    /** @param list<mixed> $original */
    private static function checkCurrent(array $current, array $original): void
    {
        if (count($current) === 0) {
            throw new OrmException(Code::ROW_CONFLICT, 'original row is missing');
        }
        if (count($current) > 1) {
            throw new OrmException(Code::ROW_IDENTITY_AMBIGUOUS, 'key selected multiple rows');
        }
        if (!self::sameRow($current[0], $original)) {
            throw new OrmException(Code::ROW_CONFLICT, 'original values changed');
        }
    }

    /** @param list<mixed> $a @param list<mixed> $b */
    private static function sameRow(array $a, array $b): bool
    {
        if (count($a) !== count($b)) {
            return false;
        }
        foreach ($a as $i => $cell) {
            if (self::cellKey($cell) !== self::cellKey($b[$i])) {
                return false;
            }
        }
        return true;
    }

    /** Reads the rows that match the primary key of a descriptor, at most two. A lock takes FOR UPDATE where the server supports it. */
    private function lookup(\PDO $pdo, CatalogTableMetadata $metadata, array $keys, bool $lock): array
    {
        $suffix = $lock && $this->dialect !== 'sqlite' ? ' FOR UPDATE' : '';
        $sql = 'SELECT ' . self::quoteList(self::columnNames($metadata), $this->dialect)
            . ' FROM ' . self::qualified($metadata->table, $this->dialect)
            . ' WHERE ' . $this->keyPredicate($metadata) . ' LIMIT 2' . $suffix;
        $raw = $this->query($pdo, $sql, $keys, 2, self::PAGE_BYTES);
        self::sameNames($raw['names'], $metadata, Code::TABLE_PAGE_METADATA_CHANGED);
        return self::convertRows($raw, self::nativeTypes($metadata));
    }

    /**
     * Refuses a MySQL row change unless the server, the account and the table are verified: partial revokes are off, the
     * account holds TRIGGER on the table, the table is InnoDB and it has no triggers (mutation.rs, mysql_safety).
     */
    private function mysqlSafety(\PDO $pdo, CatalogTableMetadata $metadata): void
    {
        $partial = $this->query($pdo, 'SELECT CAST(@@GLOBAL.partial_revokes AS SIGNED)', [], 1, 4096);
        if (count($partial['rows']) !== 1 || (string) $partial['rows'][0][0] !== '0') {
            throw new OrmException(Code::ROW_MUTATION_UNSUPPORTED, 'MySQL partial-revoke visibility requires verification');
        }

        $account = $this->query($pdo, 'SELECT CURRENT_USER()', [], 1, 4096);
        $text = $account['rows'][0][0] ?? null;
        $at = is_string($text) ? strrpos($text, '@') : false;
        if (count($account['rows']) !== 1 || !is_string($text) || $at === false) {
            throw new OrmException(Code::ROW_MUTATION_UNSUPPORTED, 'unverifiable MySQL account');
        }
        $grantee = "'" . substr($text, 0, $at) . "'@'" . substr($text, $at + 1) . "'";

        $ns = $metadata->table['namespace'];
        $grants = $this->query($pdo,
            "SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=? AND PRIVILEGE_TYPE='TRIGGER' "
            . "UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=? AND TABLE_SCHEMA=? AND PRIVILEGE_TYPE='TRIGGER' "
            . "UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=? AND TABLE_SCHEMA=? AND TABLE_NAME=? AND PRIVILEGE_TYPE='TRIGGER'",
            [$grantee, $grantee, $ns, $grantee, $ns, $metadata->table['name']], 16, 4096);
        $trigger = false;
        foreach ($grants['rows'] as $row) {
            if (count($row) === 1 && $row[0] === 'TRIGGER') {
                $trigger = true;
            }
        }
        if (!$trigger) {
            throw new OrmException(Code::ROW_MUTATION_UNSUPPORTED, 'MySQL trigger visibility is unverified');
        }

        $engine = $this->query($pdo, 'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
            [$ns, $metadata->table['name']], 2, 4096);
        if (count($engine['rows']) !== 1 || count($engine['rows'][0]) !== 1) {
            throw new OrmException(Code::ROW_MUTATION_UNSUPPORTED, 'MySQL requires InnoDB');
        }
        $name = $engine['rows'][0][0];
        if (!is_string($name) || strcasecmp($name, 'InnoDB') !== 0) {
            throw new OrmException(Code::ROW_MUTATION_UNSUPPORTED, 'MySQL requires InnoDB');
        }

        $triggers = $this->query($pdo,
            'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=? LIMIT 1',
            [$ns, $metadata->table['name']], 1, 4096);
        if ($triggers['rows'] !== []) {
            throw new OrmException(Code::ROW_MUTATION_UNSUPPORTED, 'MySQL triggers require effect verification');
        }
    }

    /**
     * Refuses a read query that is not one supported non-locking read query: it tokenizes the query, so keywords inside string
     * literals, quoted identifiers and comments are not seen, and refuses a MySQL executable comment.
     */
    private static function validateReadOnly(string $query, string $dialect): void
    {
        $refused = static fn (): OrmException => new OrmException(Code::QUERY_READ_ONLY, 'expected one supported non-locking read query');
        if ($query === '' || strlen($query) > self::SQL_BYTES) {
            throw $refused();
        }
        $words = self::words($query, $dialect);
        if ($words === null || $words === []) {
            throw $refused();
        }
        if (!in_array($words[0], ['SELECT', 'WITH', 'VALUES'], true)) {
            throw $refused();
        }
        foreach ($words as $i => $word) {
            if ($word === ';') {
                // Only one trailing semicolon is allowed; anything after it would be a second statement.
                if ($i !== count($words) - 1) {
                    throw $refused();
                }
                continue;
            }
            if (isset(self::WRITE_WORDS[$word])) {
                throw $refused();
            }
        }
    }

    /**
     * The upper-cased words of a query and its semicolons. String literals, quoted identifiers and comments are skipped. It
     * returns null for an unterminated literal or comment and for a MySQL executable comment.
     *
     * @return list<string>|null
     */
    private static function words(string $query, string $dialect): ?array
    {
        $words = [];
        $n = strlen($query);
        for ($i = 0; $i < $n;) {
            $c = $query[$i];
            if (ctype_space($c)) {
                $i++;
            } elseif ($c === '-' && str_starts_with(substr($query, $i), '--')) {
                $newline = strpos($query, "\n", $i);
                if ($newline === false) {
                    return $words;
                }
                $i = $newline + 1;
            } elseif ($c === '/' && str_starts_with(substr($query, $i), '/*')) {
                if (str_starts_with(substr($query, $i), '/*!') || str_starts_with(substr($query, $i), '/*M!')) {
                    return null;
                }
                $close = strpos($query, '*/', $i + 2);
                if ($close === false) {
                    return null;
                }
                $i = $close + 2;
            } elseif ($c === "'" || $c === '"' || $c === '`') {
                // MySQL reads backslash escapes inside string literals and double-quoted strings; other dialects do not.
                $next = self::skipQuoted($query, $i, $c, $dialect === 'mysql' && $c !== '`');
                if ($next === null) {
                    return null;
                }
                $i = $next;
            } elseif ($c === '_' || self::isLetter($c)) {
                $j = $i;
                while ($j < $n && ($query[$j] === '_' || $query[$j] === '$' || self::isLetter($query[$j]) || self::isDigit($query[$j]))) {
                    $j++;
                }
                $words[] = strtoupper(substr($query, $i, $j - $i));
                $i = $j;
            } elseif (self::isDigit($c)) {
                $j = $i;
                while ($j < $n && ($query[$j] === '.' || $query[$j] === '_' || self::isLetter($query[$j]) || self::isDigit($query[$j]))) {
                    $j++;
                }
                $i = $j;
            } else {
                if ($c === ';') {
                    $words[] = ';';
                }
                $i++;
            }
        }
        return $words;
    }

    /** The index after the literal or identifier that starts at start, with the doubled quote mark and, when backslash is set, backslash escapes. */
    private static function skipQuoted(string $query, int $start, string $quote, bool $backslash): ?int
    {
        $n = strlen($query);
        for ($i = $start + 1; $i < $n; $i++) {
            if ($backslash && $query[$i] === '\\') {
                $i++;
            } elseif ($query[$i] === $quote) {
                if ($i + 1 < $n && $query[$i + 1] === $quote) {
                    $i++;
                    continue;
                }
                return $i + 1;
            }
        }
        return null;
    }

    private static function isLetter(string $c): bool
    {
        return ($c >= 'a' && $c <= 'z') || ($c >= 'A' && $c <= 'Z');
    }

    private static function isDigit(string $c): bool
    {
        return $c >= '0' && $c <= '9';
    }
}
