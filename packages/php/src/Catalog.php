<?php

declare(strict_types=1);

namespace Polyspec\Orm;

use Polyspec\Orm\Internal\CatalogRule;

/**
 * The catalog connection (SCH-6a, docs/spec/interfaces.md "Qualified native Rust table metadata" to "Qualified Rust
 * table pages"). It reads table metadata and bounded table pages, runs validated read-only queries and changes rows
 * with explicit commands. Its descriptors and pages do not authorize a row change; each change re-reads its original
 * row inside its own transaction and compares it with the snapshot. Modelled on the Go catalog connection
 * (packages/go/orm/catalog*.go).
 */
final class Catalog
{
    private const METADATA_ROWS = 2048;
    private const METADATA_BYTES = 4194304;
    private const PAGE_BYTES = 8388608;
    private const SNAPSHOT_BYTES = 8388608;
    private const DEFAULT_ROWS = 100000;
    private const DEFAULT_BYTES = 67108864;
    /** Added to net_write_timeout: a server at 60 s ended an unread stream at 65.1 s, measured. */
    private const STREAM_END_MARGIN_SECONDS = 6;
    /** How long after a close of this catalog a connect that max_user_connections refuses is tried again (CFG-35). */
    private const REOPEN_SECONDS = 2.0;
    private const MYSQL_TYPES_TABLE = 'orm_grid_column_types';

    /** The text of each catalog value rule (docs/spec/interfaces.md "Catalog value rules", INT-167 to INT-182). */
    private const RULE_MYSQL_TIMESTAMP = 'MySQL TIMESTAMP follows a time zone';
    private const RULE_POSTGRES_ZONED = 'PostgreSQL timestamptz and timetz are unsupported';
    private const RULE_POSTGRES_NUMERIC = 'PostgreSQL numeric is not finite';
    private const RULE_NATIVE_TYPE = 'unsupported native type';
    private const RULE_DRIVER_VALUE = 'unsupported driver value';
    private const RULE_DRIVER_DECODE = 'the driver could not decode the value';
    private const RULE_DATE_RANGE = 'date outside 0001-01-01 to 9999-12-31';
    private const RULE_CALENDAR_DATE = 'date is not a calendar date';
    private const RULE_TIME_RANGE = 'time outside 00:00:00 to 23:59:59.999999';
    private const RULE_SQLITE_FORM = [
        'date' => 'the stored value is not a dbspec date',
        'time' => 'the stored value is not a dbspec time',
        'datetime' => 'the stored value is not a dbspec datetime',
    ];
    private const RULE_SQLITE_FRACTION = 'the fraction digits are not the count that its dbspec CHECK fixes';
    private const RULE_FRACTION_PAST_PRECISION = 'temporal value has more fraction digits than its precision';
    private const RULE_NATIVE_PRECISION = 'native type declares more than 6 fraction digits';
    private const RULE_BOOLEAN = 'a boolean column holds a value that is not a boolean';
    private const RULE_SETTING_CHANGED = 'the query changed a setting that the output of its values depends on';

    /** The PostgreSQL settings that the output of a cell depends on by INT-185, as columns of a read (INT-186). */
    private const PG_SETTING_COLUMNS = "current_setting('DateStyle'), current_setting('IntervalStyle'), "
        . "current_setting('TimeZone'), current_setting('extra_float_digits'), current_setting('bytea_output'), "
        . "current_setting('lc_monetary'), current_setting('search_path')";

    /**
     * The output settings that a PostgreSQL session sets for its transaction, under which the output of every cell kind
     * is its exact text (INT-186): ISO leaves the order of date input as it was.
     */
    private const PG_FIXED_SETTINGS = "SELECT set_config('DateStyle', 'ISO', true), "
        . "set_config('extra_float_digits', '1', true), set_config('bytea_output', 'hex', true)";

    /**
     * The class of each built-in PostgreSQL type by its OID (INT-185): a type of its own cell kind, a zoned type of
     * INT-168, and text for each type whose output no setting changes. Every other built-in type is refused (INT-170).
     */
    private const PG_TYPE_CLASSES = [
        16 => 'bool', 17 => 'bytea', 18 => 'text', 19 => 'text', 20 => 'int', 21 => 'int', 23 => 'int', 25 => 'text',
        26 => 'text', 114 => 'text', 142 => 'text', 650 => 'text', 700 => 'float4', 701 => 'float8', 774 => 'text',
        829 => 'text', 869 => 'text', 1042 => 'text', 1043 => 'text', 1082 => 'date', 1083 => 'time',
        1114 => 'timestamp', 1184 => 'zoned', 1266 => 'zoned', 1560 => 'text', 1562 => 'text', 1700 => 'numeric',
        2950 => 'text', 3220 => 'text', 3614 => 'text', 3615 => 'text', 3802 => 'text',
    ];

    /** Selects the native kind of a relation by its namespace and name. */
    private const KIND_SQL = [
        'mysql' => 'SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
        'postgres' => 'SELECT c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE '
            . 'n.nspname=? AND c.relname=?',
        'sqlite' => 'SELECT type FROM pragma_table_list WHERE schema=? AND name=?',
    ];

    /**
     * Selects the columns of a relation in physical order: name, native type, nullable, generated, primary-key ordinal,
     * automatic key, default expression and whether the default is an expression.
     */
    private const COLUMNS_SQL = [
        // The key ordinal is a subquery that names the table by constants, which neither server reads by opening
        // every table of every database, as MariaDB reads a join of KEY_COLUMN_USAGE (DIA-210). It takes the
        // namespace and the name twice. The native type is COLUMN_TYPE in the form of MySQL 8.4, which MariaDB
        // writes with an integer display width (DIA-204).
        'mysql' => "SELECT c.COLUMN_NAME,CASE WHEN c.COLUMN_TYPE='year(4)' THEN 'year' WHEN c.DATA_TYPE IN ('tinyint',"
            . "'smallint','mediumint','int','bigint') AND c.COLUMN_TYPE<>'tinyint(1)' AND c.COLUMN_TYPE NOT LIKE "
            . "'%zerofill' AND LOCATE('(',c.COLUMN_TYPE)>0 THEN CONCAT(c.DATA_TYPE,SUBSTRING(c.COLUMN_TYPE,"
            . "LOCATE(')',c.COLUMN_TYPE)+1)) ELSE c.COLUMN_TYPE END,c.IS_NULLABLE='YES',"
            . "(c.GENERATION_EXPRESSION IS NOT NULL AND "
            . "c.GENERATION_EXPRESSION<>''),COALESCE((SELECT k.ORDINAL_POSITION FROM "
            . "information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA=? AND k.TABLE_NAME=? AND "
            . "k.CONSTRAINT_NAME='PRIMARY' AND k.COLUMN_NAME=c.COLUMN_NAME),0),(c.EXTRA LIKE '%auto_increment%'),"
            . "c.COLUMN_DEFAULT,(c.EXTRA LIKE '%DEFAULT_GENERATED%') FROM information_schema.COLUMNS c WHERE "
            . "c.TABLE_SCHEMA=? AND c.TABLE_NAME=? ORDER BY c.ORDINAL_POSITION",
        'postgres' => 'SELECT a.attname::text,format_type(a.atttypid,a.atttypmod),NOT '
            . 'a.attnotnull,(a.attgenerated<>\'\' OR '
            . 'a.attidentity=\'a\'),COALESCE(k.ord,0),(a.attidentity<>\'\'),CASE WHEN length(a.attgenerated)=0 '
            . 'THEN pg_get_expr(d.adbin,d.adrelid) END,(d.adbin '
            . 'IS NOT NULL AND length(a.attgenerated)=0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace '
            . 'JOIN pg_attribute a ON '
            . 'a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN '
            . 'pg_index i ON i.indrelid=c.oid AND i.indisprimary LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY '
            . 'AS k(attnum,ord) ON k.attnum=a.attnum WHERE n.nspname=? AND c.relname=? AND a.attnum>0 AND NOT '
            . 'a.attisdropped ORDER BY a.attnum',
        'sqlite' => 'SELECT name,type,NOT "notnull",hidden<>0,pk,0,dflt_value,(dflt_value IS NOT NULL) FROM '
            . 'pragma_table_xinfo(?,?) ORDER BY cid',
    ];

    /** The keywords that a read query never uses as a statement or clause; a query that contains one is refused. */
    private const WRITE_WORDS = [
        'INSERT' => true, 'UPDATE' => true, 'DELETE' => true, 'MERGE' => true, 'UPSERT' => true, 'CREATE' => true,
        'DROP' => true, 'ALTER' => true, 'TRUNCATE' => true, 'RENAME' => true, 'GRANT' => true, 'REVOKE' => true,
        'CALL' => true,
        'DO' => true,
        'INTO' => true,
        'LOCK' => true,
        'SHARE' => true,
        'PROCEDURE' => true,
        'LOAD' => true,
        'COPY' => true, 'ATTACH' => true, 'DETACH' => true, 'PRAGMA' => true, 'VACUUM' => true, 'REINDEX' => true,
        'ANALYZE' => true,
    ];

    private bool $closed = false;

    /** @var array<int, string> the classes of the PostgreSQL types that the session looked up, by OID (pgClass) */
    private array $pgTypeClasses = [];

    /** @var list<mixed>|null the PostgreSQL output settings when the transaction of the session began (INT-186) */
    private ?array $pgSettings = null;

    /** @var int The server's net_write_timeout, read once at connect, in seconds. */
    private int $netWriteTimeout = 0;

    /** Whether a stop left a stream unread, so that the server has ended this connection (INT-157). */
    private bool $streamLeft = false;

    /** Until when, in hrtime seconds, a refused connect is a connection of this catalog still on the server (CFG-35). */
    private float $reopenUntil = 0.0;

    /**
     * The MySQL connection that a budget stop kills the statement of a read through (CFG-35). The catalog opens it at
     * its first stop and keeps it until close, so that no stop closes a connection that a later stop must open again.
     */
    private ?Db $killer = null;

    private function __construct(
        private Db $db,
        private readonly string $dialect,
        private readonly string $dsn,
    ) {
    }

    /**
     * Opens the catalog connection of a mysql, postgres, sqlite or markdown DSN. A SQLite DSN must name an existing
     * regular file, and the connection never creates one. A flowmark server runs SQL in SQLite's dialect on the
     * corpus, so the catalog of a corpus is a SQLite catalog (docs/spec/dialects.md DIA-185).
     */
    public static function connect(string $dsn): self
    {
        if (preg_match('#^markdown://#i', $dsn) === 1) {
            return new self(Orm::connect($dsn, new Config()), 'sqlite', $dsn);
        }
        [$driver, $pdoDsn] = Orm::parseDsn($dsn);
        if ($driver === 'sqlite') {
            // A symbolic link is not a regular file.
            $path = substr($pdoDsn, strlen('sqlite:'));
            if (is_link($path) || !is_file($path)) {
                throw new OrmException(Code::CONFIG, 'CATALOG_SQLITE_FILE: expected an existing regular file');
            }
        }
        $catalog = new self(Orm::connect($dsn, new Config()), $driver, $dsn);
        if ($driver === 'mysql') {
            try {
                $catalog->netWriteTimeout = (int) $catalog->db->pdo()
                    ->query('SELECT @@SESSION.net_write_timeout')->fetchColumn();
            } catch (\PDOException $e) {
                $mapped = $catalog->db->driverError($e);
                $catalog->db->close();
                throw $mapped;
            }
        }
        return $catalog;
    }

    /** The database of the connection: mysql, postgres or sqlite. */
    public function dialect(): string
    {
        return $this->dialect;
    }

    /** Releases the connection. */
    public function close(): void
    {
        if ($this->closed) {
            return;
        }
        $this->closed = true;
        $killer = $this->killer;
        $this->killer = null;
        try {
            $this->closeConnection();
        } finally {
            $killer?->close();
        }
    }

    /**
     * Stops the statement that a budget ended on the server: KILL QUERY on the kill connection, which the first stop
     * opens and the catalog keeps, so that the budgeted connection stays usable and no connection closes (CFG-35). The
     * catalog is not poisoned, unlike a Cancellation signal. A kill connection that failed is closed.
     */
    private function killQuery(int $connectionId): void
    {
        $this->killer ??= $this->openConnection();
        try {
            $this->killer->pdo()->exec('KILL QUERY ' . $connectionId);
        } catch (\Throwable $e) {
            $killer = $this->killer;
            $this->killer = null;
            try {
                $killer->close();
            } finally {
                $this->reopenUntil = hrtime(true) / 1e9 + self::REOPEN_SECONDS;
            }
            throw $e;
        }
    }

    /**
     * Opens a connection. A connection that this catalog closed holds its place in max_user_connections until the
     * server ends that thread. The server announces that to no one, so this is a timer: the connect is tried again
     * within the 2 s of CFG-35 from the close (within 40 ms measured). A connect that follows no close of this catalog
     * fails at once.
     */
    private function openConnection(): Db
    {
        for (;;) {
            try {
                return Orm::connect($this->dsn, new Config());
            } catch (OrmException $refused) {
                $cause = $refused->getPrevious();
                if (
                    !$cause instanceof \PDOException
                    || (int) $cause->getCode() !== 1226
                    || hrtime(true) / 1e9 >= $this->reopenUntil
                ) {
                    throw $refused;
                }
                usleep(10000);
            }
        }
    }


    /**
     * The namespace of the connection: the current schema of PostgreSQL, the current database of MySQL and main for
     * SQLite.
     */
    public function currentNamespace(): string
    {
        $this->assertOpen();
        if ($this->dialect === 'sqlite') {
            return 'main';
        }
        $query = $this->dialect === 'postgres' ? 'SELECT current_schema()' : 'SELECT DATABASE()';
        return $this->session(true, function (\PDO $pdo) use ($query): string {
            $raw = $this->query($pdo, $query, [], 2, self::METADATA_BYTES);
            if (count($raw['rows']) !== 1 || count($raw['rows'][0]) !== 1) {
                throw new OrmException(
                    Code::TABLE_NAMESPACE_UNAVAILABLE,
                    'the connection reported no single namespace'
                );
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
     * Reads the metadata of an explicitly qualified table, {namespace, name}, in a read-only session. The descriptor
     * must be the same when it is read again within the session.
     *
     * @param array{namespace: string, name: string} $table
     */
    public function describeTable(array $table): CatalogTableMetadata
    {
        $ref = self::tableRef($table);
        return $this->session(true, fn (\PDO $pdo): CatalogTableMetadata => $this->describe($pdo, $ref));
    }

    /**
     * Reads one bounded page of an explicitly qualified table in primary-key order, in a fresh read-only session. A
     * table without a primary key has no defined order. The descriptor must be the same before and after the read.
     *
     * @param array{namespace: string, name: string} $table
     */
    public function tablePage(array $table, int $limit, int $offset): CatalogTablePage
    {
        $ref = self::tableRef($table);
        if ($limit < 1 || $limit > 1000 || $offset < 0 || $offset > 1000000) {
            throw new OrmException(Code::TABLE_PAGE_INVALID, 'limit requires 1..1000 and offset 0..1000000');
        }
        return $this->session(true, function (\PDO $pdo) use ($ref, $limit, $offset): CatalogTablePage {
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
            try {
                $raw = $this->query($pdo, $sql, [], $limit + 1, self::PAGE_BYTES, cells: true);
            } catch (OrmException $failure) {
                // A column that went away during the read fails the statement: the descriptor tells that from any other
                // failure.
                if ($failure->code_ !== Code::CATALOG_LIMIT && !$this->streamLeft) {
                    try {
                        $changed = !self::samePageDescriptor($this->describe($pdo, $ref), $metadata);
                    } catch (OrmException) {
                        $changed = false;
                    }
                    if ($changed) {
                        throw new OrmException(
                            Code::TABLE_PAGE_METADATA_CHANGED,
                            'descriptor changed during read',
                            $failure
                        );
                    }
                }
                throw $failure;
            }
            self::sameNames($raw['names'], $metadata, Code::TABLE_PAGE_METADATA_CHANGED);
            if (!self::samePageDescriptor($this->describe($pdo, $ref), $metadata)) {
                throw new OrmException(Code::TABLE_PAGE_METADATA_CHANGED, 'descriptor changed during read');
            }
            // The sentinel row is cut before conversion, so a value past the page is never read.
            $hasMore = count($raw['rows']) > $limit;
            if ($hasMore) {
                $raw['rows'] = array_slice($raw['rows'], 0, $limit);
            }
            $rows = $this->describedRows($pdo, $raw, $metadata);
            return new CatalogTablePage(
                $metadata,
                new CatalogResult(self::columnNames($metadata), $rows),
                $limit,
                $offset,
                $metadata->primaryKey,
                $hasMore
            );
        });
    }

    /**
     * Captures the row at index of a page as a snapshot. The table must have a reliable row identity, and the page must
     * be a page of that table as tablePage reads it.
     */
    public function rowSnapshotFromPage(CatalogTablePage $page, int $index): CatalogRowSnapshot
    {
        $metadata = $page->metadata;
        try {
            self::checkName($metadata->table['namespace']);
            self::checkName($metadata->table['name']);
        } catch (OrmException $e) {
            throw new OrmException(
                Code::ROW_SNAPSHOT_INVALID,
                'invalid original row or descriptor: ' . $e->getMessage(),
                $e
            );
        }
        if ($page->limit < 1 || $page->limit > 1000 || $page->offset < 0 || $page->offset > 1000000) {
            throw new OrmException(Code::ROW_SNAPSHOT_INVALID, 'invalid page bounds');
        }
        $rows = $page->result->rows;
        if (
            count($rows) > $page->limit || ($page->hasMore && count($rows) !== $page->limit)
            || $page->orderBy !== $metadata->primaryKey
        ) {
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
     * Runs one read query (SELECT, WITH or VALUES) in a fresh read-only session. A query that writes, locks or has more
     * than one statement fails with QUERY_READ_ONLY before it runs. Placeholders are `?`; a result over a limit fails,
     * never truncated.
     *
     * @param list<mixed> $params
     */
    public function readOnlyQuery(string $sql, array $params = [], int $maxRows = 0, int $maxBytes = 0): CatalogResult
    {
        return $this->readOnly($sql, $params, $maxRows, $maxBytes, false);
    }

    /**
     * Runs one read query like readOnlyQuery, and types each cell by its native column type: float cells hold their
     * IEEE-754 bits, UNSIGNED integers are unsigned cells, DECIMAL is plain text, date, time and datetime hold the
     * dbspec text with six fraction digits, binary is bytes and NULL is a null cell. MySQL TIMESTAMP, PostgreSQL
     * timestamptz and timetz, and values outside the dbspec ranges fail with CATALOG_VALUE. Rows hold CatalogGridCell
     * values.
     *
     * @param list<mixed> $params
     */
    public function readOnlyGridQuery(
        string $sql,
        array $params = [],
        int $maxRows = 0,
        int $maxBytes = 0
    ): CatalogResult {
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
        return $this->session(true, function (\PDO $pdo) use ($sql, $args, $maxRows, $maxBytes, $grid): CatalogResult {
            if ($grid) {
                try {
                    $raw = $this->gridQuery($pdo, $sql, $args, $maxRows, $maxBytes);
                } catch (OrmException $e) {
                    if ($this->dialect === 'mysql' && $e->code_ === Code::READ_ONLY) {
                        throw new OrmException(
                            Code::QUERY_READ_ONLY,
                            'the database rejected a read-only grid query',
                            $e
                        );
                    }
                    throw $e;
                }
                return new CatalogResult($raw['names'], $raw['rows']);
            }
            $raw = $this->query(
                $pdo,
                $sql,
                $args,
                $maxRows,
                $maxBytes,
                fn (mixed $value, string $native, int $column): mixed => $this->queryValue($value, $native, $column),
                true
            );
            return new CatalogResult($raw['names'], $raw['rows']);
        });
    }

    /**
     * Inserts one row with explicit primary-key values inside a writable transaction. It rejects an existing key,
     * writes with bound parameters, requires exactly one affected row and re-reads the row by its key before it
     * commits. Every supplied value must read back exactly. A supported database-owned key may be omitted when the
     * database returns its generated row in the same transaction.
     *
     * The values are a list of [name, value] pairs, or a map of column name => value. A repeated name in the list is
     * refused with ROW_INSERT_INVALID before any write (INT-111).
     *
     * @param list<array{string, mixed}>|array<string, mixed> $values
     */
    public function insertRow(CatalogTableMetadata $declared, array $values): CatalogResult
    {
        self::checkWritePrecision($this->dialect, $declared, $values);
        $keyIndexes = self::descriptorKeys($declared);
        $changes = self::changes($declared, $values, Code::ROW_INSERT_INVALID);
        $provided = [];
        foreach ($changes as [$index, $value]) {
            $provided[$index] = $value;
        }
        $keys = [];
        $generatedKeyIndexes = [];
        foreach ($keyIndexes as $index) {
            if (!array_key_exists($index, $provided)) {
                $column = $declared->columns[$index];
                if ($column->automaticKey || $column->defaultExpression !== null) {
                    $generatedKeyIndexes[] = $index;
                    continue;
                }
                throw new OrmException(
                    Code::ROW_INSERT_IDENTITY_REQUIRED,
                    'explicit primary-key value of "' . $column->name . '" is required'
                );
            }
            $keys[] = $provided[$index];
        }
        $mysqlAutoKeyCount = count(array_filter(
            $generatedKeyIndexes,
            fn (int $index): bool => $declared->columns[$index]->automaticKey
        ));
        if ($this->dialect === 'mysql' && $mysqlAutoKeyCount > 1) {
            throw new OrmException(Code::ROW_INSERT_UNSUPPORTED, 'multiple AUTO_INCREMENT identities');
        }
        return $this->session(
            false,
            function (\PDO $pdo) use (
                $declared,
                $changes,
                $keys,
                $generatedKeyIndexes,
                $keyIndexes,
                $provided
            ): CatalogResult {
                $hasGeneratedKeys = $generatedKeyIndexes !== [];
                if ($this->dialect === 'postgres') {
                    // The lock that an INSERT takes, held before the schema check so that no DDL changes the table in
                    // between.
                    $this->exec(
                        $pdo,
                        'LOCK TABLE ' . self::qualified($declared->table, $this->dialect) . ' IN ROW EXCLUSIVE MODE',
                        []
                    );
                }
                if ($this->dialect === 'mysql' && $hasGeneratedKeys) {
                    $this->query(
                        $pdo,
                        'SELECT 1 FROM ' . self::qualified($declared->table, $this->dialect) . ' LIMIT 0 FOR UPDATE',
                        [],
                        1,
                        self::PAGE_BYTES
                    );
                }
                if (!$hasGeneratedKeys && $this->lookup($pdo, $declared, $keys, true) !== []) {
                    throw new OrmException(Code::ROW_CONFLICT, 'insertion key already exists');
                }
                $descriptor = $this->describe($pdo, $declared->table);
                if ($descriptor != $declared) {
                    throw new OrmException(Code::ROW_SCHEMA_CHANGED, 'insertion descriptor changed');
                }
                if ($this->dialect === 'mysql') {
                    $this->mysqlSafety($pdo, $descriptor);
                }
                $mysqlLocatorSql = null;
                $mysqlLocatorArgs = [];
                $hasExpressionKey = false;
                foreach ($generatedKeyIndexes as $index) {
                    $hasExpressionKey = $hasExpressionKey || $descriptor->columns[$index]->expressionDefault;
                }
                $hasExpressionKey = $this->dialect === 'mysql' && $hasExpressionKey;
                if ($hasExpressionKey) {
                    $predicates = [];
                    foreach ($changes as [$index, $value]) {
                        $column = self::quote($descriptor->columns[$index]->name, $this->dialect);
                        if ($value === null) {
                            $predicates[] = "$column IS NULL";
                        } else {
                            $predicates[] = "$column=?";
                            $mysqlLocatorArgs[] = $value;
                        }
                    }
                    $mysqlLocatorSql = 'SELECT ' . self::quoteList(self::columnNames($descriptor), $this->dialect)
                        . ' FROM ' . self::qualified($descriptor->table, $this->dialect)
                        . ' WHERE ' . ($predicates === [] ? '1=1' : implode(' AND ', $predicates))
                        . ' LIMIT 2 FOR UPDATE';
                    $before = $this->query($pdo, $mysqlLocatorSql, $mysqlLocatorArgs, 2, self::PAGE_BYTES);
                    self::sameNames($before['names'], $descriptor, Code::TABLE_PAGE_METADATA_CHANGED);
                    if ($before['rows'] !== []) {
                        throw new OrmException(
                            Code::ROW_IDENTITY_AMBIGUOUS,
                            'generated identity locator already matches rows'
                        );
                    }
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
                    . ($names === [] ? ($this->dialect === 'mysql' ? '() VALUES()' : ' DEFAULT VALUES')
                        : ' (' . implode(',', $names) . ') VALUES (' . implode(',', $placeholders) . ')');
                if ($hasGeneratedKeys && $this->dialect !== 'mysql') {
                    $returned = $this->query(
                        $pdo,
                        $sql . ' RETURNING ' . self::quoteList(self::columnNames($descriptor), $this->dialect),
                        $args,
                        2,
                        self::PAGE_BYTES,
                        cells: true
                    );
                    if (count($returned['rows']) !== 1) {
                        throw new OrmException(Code::ROW_WRITE_MISMATCH, 'expected one returned insert row');
                    }
                    $returnedRows = $this->rowsForDescriptor($pdo, $returned, $descriptor);
                    $keys = array_map(static fn (int $index): mixed => $returnedRows[0][$index], $keyIndexes);
                } else {
                    $affected = $this->exec($pdo, $sql, $args);
                    if ($affected !== 1) {
                        throw new OrmException(
                            Code::ROW_WRITE_MISMATCH,
                            "expected exactly one inserted row, got $affected"
                        );
                    }
                    if ($hasGeneratedKeys) {
                        if ($mysqlLocatorSql !== null) {
                            $returned = $this->query(
                                $pdo,
                                $mysqlLocatorSql,
                                $mysqlLocatorArgs,
                                2,
                                self::PAGE_BYTES,
                                cells: true
                            );
                            $returnedRows = $this->rowsForDescriptor($pdo, $returned, $descriptor);
                            $returnedRow = self::verifyInsertedRow(
                                $returnedRows,
                                $changes,
                                Code::ROW_IDENTITY_AMBIGUOUS,
                                'expected exactly one inserted locator row',
                                $descriptor
                            );
                            $keys = array_map(static fn (int $index): mixed => $returnedRow[$index], $keyIndexes);
                        } else {
                            $identity = null;
                            foreach ($generatedKeyIndexes as $index) {
                                if ($descriptor->columns[$index]->automaticKey) {
                                    try {
                                        $identity = $pdo->lastInsertId();
                                    } catch (\PDOException $error) {
                                        throw $this->db->driverError($error);
                                    }
                                    if (
                                        !is_string($identity)
                                        || !preg_match('/^[0-9]+$/D', $identity)
                                        || $identity === '0'
                                    ) {
                                        throw new OrmException(
                                            Code::ROW_WRITE_MISMATCH,
                                            'insert acknowledgement mismatch'
                                        );
                                    }
                                    break;
                                }
                            }
                            $predicates = [];
                            $keyArgs = [];
                            foreach ($keyIndexes as $index) {
                                $column = $descriptor->columns[$index];
                                $quoted = self::quote($column->name, $this->dialect);
                                if (array_key_exists($index, $provided)) {
                                    $predicates[] = "$quoted=?";
                                    $keyArgs[] = $provided[$index];
                                } elseif ($column->automaticKey) {
                                    if ($identity === null) {
                                            throw new OrmException(
                                                Code::ROW_WRITE_MISMATCH,
                                                'insert acknowledgement mismatch'
                                            );
                                    }
                                    $predicates[] = "$quoted=?";
                                    $keyArgs[] = $identity;
                                } else {
                                    $predicates[] = "$quoted=DEFAULT($quoted)";
                                }
                            }
                            $returned = $this->query(
                                $pdo,
                                'SELECT ' . self::quoteList(self::columnNames($descriptor), $this->dialect)
                                    . ' FROM ' . self::qualified($descriptor->table, $this->dialect)
                                    . ' WHERE ' . implode(' AND ', $predicates) . ' LIMIT 2 FOR UPDATE',
                                $keyArgs,
                                2,
                                self::PAGE_BYTES,
                                cells: true
                            );
                            $returnedRows = $this->rowsForDescriptor($pdo, $returned, $descriptor);
                            $returnedRow = self::verifyInsertedRow(
                                $returnedRows,
                                $changes,
                                Code::ROW_WRITE_MISMATCH,
                                'expected one generated-key row',
                                $descriptor
                            );
                            $keys = array_map(static fn (int $index): mixed => $returnedRow[$index], $keyIndexes);
                        }
                    }
                }
                $after = $this->lookup($pdo, $descriptor, $keys, false);
                if (count($after) !== 1) {
                    throw new OrmException(Code::ROW_WRITE_MISMATCH, 'expected exactly one inserted row');
                }
                if ($this->describe($pdo, $declared->table) != $descriptor) {
                    throw new OrmException(Code::ROW_SCHEMA_CHANGED, 'insertion descriptor changed');
                }
                self::assertStoredValues($after[0], $changes, $descriptor);
                return new CatalogResult(self::columnNames($descriptor), $after);
            }
        );
    }

    /**
     * Updates the row of an original snapshot. Inside the transaction it re-reads the row by its original keys, locks
     * it, compares it with the snapshot and then writes. After the write it re-reads the row by its resulting keys and
     * requires every ordinary column to hold the value that was written. A failed check rolls back.
     *
     * The values are a list of [name, value] pairs, or a map of column name => value. A repeated name in the list is
     * refused with ROW_UPDATE_INVALID before any write (INT-111).
     *
     * @param list<array{string, mixed}>|array<string, mixed> $values
     */
    public function updateRow(CatalogRowSnapshot $original, array $values): CatalogResult
    {
        self::checkWritePrecision($this->dialect, $original->metadata, $values);
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
        return $this->session(false, function (\PDO $pdo) use (
            $original,
            $changes,
            $updated,
            $keys,
            $newKeys,
        ): CatalogResult {
            $descriptor = $this->lockOriginalRow($pdo, $original, $keys);
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
                throw new OrmException(
                    Code::ROW_WRITE_MISMATCH,
                    'expected exactly one updated row, got ' . count($after)
                );
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
                    throw new OrmException(
                        Code::ROW_WRITE_MISMATCH,
                        'stored ordinary values of "' . $column->name . '" differ'
                    );
                }
            }
            return new CatalogResult(self::columnNames($descriptor), $after);
        });
    }

    /**
     * Deletes the row of an original snapshot. Inside the transaction it locks and compares the row, requires exactly
     * one affected row and verifies that no row remains under the key. It returns the number of rows deleted.
     */
    public function deleteRow(CatalogRowSnapshot $original): int
    {
        self::validSnapshot($original);
        $keys = self::keysOf($original);
        return $this->session(false, function (\PDO $pdo) use ($original, $keys): int {
            $descriptor = $this->lockOriginalRow($pdo, $original, $keys);
            $sql = 'DELETE FROM ' . self::qualified(
                $descriptor->table,
                $this->dialect
            ) . ' WHERE ' . $this->keyPredicate($descriptor);
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
     * Locks and verifies the original snapshot before a row mutation.
     *
     * @param list<mixed> $keys
     */
    private function lockOriginalRow(\PDO $pdo, CatalogRowSnapshot $original, array $keys): CatalogTableMetadata
    {
        $current = $this->lookup($pdo, $original->metadata, $keys, true);
        $descriptor = $this->describe($pdo, $original->metadata->table);
        if ($descriptor != $original->metadata) {
            throw new OrmException(Code::ROW_SCHEMA_CHANGED, 'original descriptor changed');
        }
        self::checkCurrent($current, $original->cells);
        if ($this->dialect === 'mysql') {
            $this->mysqlSafety($pdo, $descriptor);
        }
        return $descriptor;
    }

    /**
     * Runs a bounded query and types each cell by the native type of its column (gridCell). SQLite types each value, so
     * its cells take the type of their own value.
     *
     * @param list<mixed> $args
     * @return array{names: list<string>, rows: list<list<CatalogGridCell>>}
     */
    private function gridQuery(\PDO $pdo, string $sql, array $args, int $maxRows, int $maxBytes): array
    {
        try {
            [$settings, $sql] = $this->cellsRead($sql, true);
            if ($this->dialect === 'postgres' && $args === []) {
                return $this->cursorGrid($pdo, $sql, $maxRows, $maxBytes, $settings);
            }
            // MySQL streams the rows, so that a budget stops a read before the rest of its result; PDO reports neither
            // the UNSIGNED flag nor the binary charset, so the column definitions are read first, with no result open.
            $streamed = $this->dialect === 'mysql';
            $columns = $streamed ? $this->mysqlGridColumns($pdo, $sql, $args) : null;
            $connectionId = $streamed ? $this->mysqlConnectionId($pdo) : null;
            $st = $this->prepareQuery($pdo, $sql, $args, $streamed);
            return $this->readStatement($st, $connectionId, function () use (
                $pdo,
                $st,
                $columns,
                $maxRows,
                $maxBytes,
                $settings
            ): array {
                $metas = self::withoutSettings(self::columnMetas($st), $settings);
                $fetch = static fn (): array|false => $st->fetch(\PDO::FETCH_NUM);
                $classes = [];
                if ($this->dialect === 'postgres') {
                    if (!self::pgBuiltins($metas)) {
                        // A lookup of a type runs a statement, which ends this one, so its rows are read first.
                        $fetch = self::bufferedFetch($st);
                    }
                    $classes = $this->pgClasses($pdo, $metas);
                    self::refuseMultirange($classes);
                }
                $rows = $this->boundedRows(
                    $fetch,
                    $maxRows,
                    $maxBytes,
                    function (array $row) use ($st, $columns, $classes): array {
                        $cells = [];
                        foreach ($row as $i => $value) {
                            try {
                                if ($columns !== null) {
                                    [$native, $unsigned, $binary, $bits] = $columns[$i];
                                    $cells[] = self::mysqlGridCell($value, $native, $unsigned, $binary, $bits);
                                } elseif ($this->dialect === 'postgres') {
                                    $cells[] = self::postgresGridCell($value, $classes[$i]);
                                } else {
                                    // SQLite reports whether each value is a blob.
                                    $cellMeta = $st->getColumnMeta($i) ?: [];
                                    $binary = in_array('blob', (array) ($cellMeta['flags'] ?? []), true);
                                    $cells[] = self::sqliteGridCell($value, $binary);
                                }
                            } catch (CatalogRule $rule) {
                                throw self::atColumn($rule, $i + 1);
                            }
                        }
                        return $cells;
                    },
                    $settings
                );
                return ['names' => self::metaNames($metas), 'rows' => $rows];
            });
        } catch (\PDOException $e) {
            throw $this->db->driverError($e);
        }
    }

    /**
     * The native type, the UNSIGNED flag and the binary charset of each column of a MySQL grid query. The query runs
     * once with sql_select_limit 0, which gives its columns and no row. PDO reports neither the flag nor the charset,
     * so both come from the server, through the column types of a temporary table of the same query (INT-157).
     *
     * @param list<mixed> $args
     * @return list<array{string, bool, bool, int}>
     */
    private function mysqlGridColumns(\PDO $pdo, string $sql, array $args): array
    {
        $pdo->exec('SET SESSION sql_select_limit = 0');
        try {
            $st = $this->prepareQuery($pdo, $sql, $args, true);
            $metas = self::columnMetas($st);
            $st->closeCursor();
        } finally {
            $pdo->exec('SET SESSION sql_select_limit = DEFAULT');
        }
        $types = $this->mysqlResultTypes($pdo, $sql, $args, count($metas));
        $columns = [];
        foreach ($metas as $i => $meta) {
            $type = $types[$i] ?? '';
            $columns[] = [
                strtoupper((string) ($meta['native_type'] ?? '')),
                str_contains($type, 'unsigned'),
                preg_match('/^(binary|varbinary|tinyblob|blob|mediumblob|longblob)\b/', $type) === 1,
                // PDO reports the width of a BIT column as its length.
                (int) ($meta['len'] ?? 0),
            ];
        }
        return $columns;
    }

    /**
     * The lower-case column types of the result of a MySQL query, as the server derives them: a temporary table of the
     * query, under WHERE FALSE, holds no row. A READ ONLY transaction refuses the statement, so the read transaction
     * ends around it, and the server refuses a stored function that writes while the table is created. A server that
     * refuses the statement, as for a user without CREATE TEMPORARY TABLES, leaves the cells to their values (INT-157).
     *
     * @param list<mixed> $args
     * @return list<string>
     */
    private function mysqlResultTypes(\PDO $pdo, string $sql, array $args, int $count): array
    {
        $pdo->exec('COMMIT');
        $names = implode(',', array_map(static fn (int $i): string => "c$i", array_keys(array_fill(0, $count, 0))));
        $query = rtrim($sql, " \t\r\n;");
        $table = self::MYSQL_TYPES_TABLE;
        $types = [];
        try {
            $create = "CREATE TEMPORARY TABLE $table AS WITH q($names) AS (\n$query\n) SELECT * FROM q WHERE FALSE";
            $this->prepareQuery($pdo, $create, $args, true)->closeCursor();
            try {
                $shown = $pdo->query("SHOW COLUMNS FROM $table");
                foreach ($shown === false ? [] : $shown->fetchAll(\PDO::FETCH_NUM) as $row) {
                    $types[] = strtolower((string) $row[1]);
                }
            } finally {
                $pdo->exec("DROP TEMPORARY TABLE $table");
            }
        } catch (\PDOException) {
            $types = [];
        }
        $pdo->exec(self::beginSql('mysql', true));
        return $types;
    }

    /**
     * The name of each column, from its metadata; a column without one has the empty name.
     *
     * @param list<array<string, mixed>> $metas
     * @return list<string>
     */
    private static function metaNames(array $metas): array
    {
        return array_map(static fn (array $meta): string => (string) ($meta['name'] ?? ''), $metas);
    }

    /**
     * The column metadata of a statement that ran.
     *
     * @return list<array<string, mixed>>
     */
    private static function columnMetas(\PDOStatement $st): array
    {
        $metas = [];
        for ($i = 0, $n = $st->columnCount(); $i < $n; $i++) {
            $metas[] = $st->getColumnMeta($i) ?: [];
        }
        return $metas;
    }

    /** The id of a MySQL connection, which a budget stop kills its query by; it is read before the query runs. */
    private function mysqlConnectionId(\PDO $pdo): ?int
    {
        $statement = $pdo->prepare('SELECT CONNECTION_ID()');
        $statement->execute();
        $row = $statement->fetch(\PDO::FETCH_NUM);
        $id = is_array($row) ? $row[0] : null;
        return is_numeric($id) ? (int) $id : null;
    }

    /**
     * Reads a statement that ran. A budget that stops the read leaves the rest of the result unread, so a MySQL stop
     * kills the query. The killed query ends its cursor with an interrupted error, which is the expected end of a stop,
     * so only a failure without a stop is raised.
     *
     * @template T
     * @param \Closure(): T $read
     * @return T
     */
    /**
     * Waits for the server to end a stream whose kill failed (INT-157, CFG-35). PDO reads the rest of a streaming
     * result whenever a statement or its connection closes, so the read stops reading instead. The server then fails
     * its write and ends the connection after net_write_timeout. This is a timer because no orthodox mechanism exists:
     * the busy connection cannot be asked and no second one can be opened. If the server has not ended the stream by
     * then, the close reads the rest, which is slower and still correct.
     */
    private function leaveStream(): void
    {
        $this->streamLeft = true;
        sleep($this->netWriteTimeout + self::STREAM_END_MARGIN_SECONDS);
    }

    /** Closes the connection; the one that a left stream has lost has nothing to report. */
    private function closeConnection(): void
    {
        try {
            $this->db->close();
        } catch (OrmException | \PDOException $e) {
            if (!$this->streamLeft) {
                throw $e;
            }
        }
    }

    private function readStatement(\PDOStatement $st, ?int $connectionId, \Closure $read): mixed
    {
        $stopped = false;
        try {
            return $read();
        } catch (OrmException $stop) {
            $stopped = $connectionId !== null && $stop->code_ === Code::CATALOG_LIMIT;
            if ($stopped) {
                try {
                    $this->killQuery($connectionId);
                } catch (OrmException | \PDOException) {
                    $this->leaveStream();
                }
            }
            throw $stop;
        } finally {
            try {
                $st->closeCursor();
            } catch (\PDOException $cursorError) {
                if (!$stopped) {
                    throw $cursorError;
                }
            }
        }
    }

    /**
     * The grid cell of one MySQL driver value (INT-165 to INT-185). native is the upper-cased field type name that PDO
     * reports for the column; unsigned is an UNSIGNED column, binary a binary string and bits the width of a BIT.
     */
    private static function mysqlGridCell(
        mixed $value,
        string $native,
        bool $unsigned,
        bool $binary,
        int $bits
    ): CatalogGridCell {
        if ($value === null) {
            return new CatalogGridCell('null');
        }
        return match ($native) {
            'FLOAT' => self::float32Cell($value),
            'DOUBLE' => self::float64Cell($value),
            'TIMESTAMP' => throw self::rule(Code::CATALOG_VALUE, self::RULE_MYSQL_TIMESTAMP),
            'DATE', 'NEWDATE' => new CatalogGridCell('date', self::serverDate(self::driverText($value))),
            'DATETIME' => new CatalogGridCell('datetime', self::serverDateTime(self::driverText($value))),
            'TIME' => new CatalogGridCell('time', self::serverTime(self::driverText($value))),
            'DECIMAL', 'NEWDECIMAL' => new CatalogGridCell('decimal', self::decimalText($value)),
            'YEAR' => new CatalogGridCell('integer', self::yearNumber($value)),
            'LONG', 'LONGLONG', 'SHORT', 'TINY', 'INT24' => self::integerCell($value, $unsigned),
            // The server returns a bit value as a binary string and a geometry as its SRID and WKB (INT-185).
            'BIT' => new CatalogGridCell('binary', self::bitBytes($value, $bits)),
            'GEOMETRY' => new CatalogGridCell('binary', self::driverBytes($value)),
            'JSON' => self::textCell($value),
            // ENUM and SET columns arrive as STRING; a TEXT column arrives as BLOB, so the charset tells the two.
            'STRING', 'VAR_STRING', 'VARCHAR', 'BLOB', 'TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB' => $binary
                ? new CatalogGridCell('binary', self::driverBytes($value))
                : self::textCell($value),
            default => throw self::rule(Code::CATALOG_VALUE, self::RULE_NATIVE_TYPE),
        };
    }

    /** The grid cell of one PostgreSQL driver value, by the class of its column type (pgClass). */
    private static function postgresGridCell(mixed $value, string $class): CatalogGridCell
    {
        if ($value === null) {
            return new CatalogGridCell('null');
        }
        return match ($class) {
            'int' => self::integerCell($value, false),
            'float4' => self::float32Cell($value),
            'float8' => self::float64Cell($value),
            'numeric' => new CatalogGridCell('decimal', self::postgresNumeric($value)),
            'bool' => is_bool($value)
                ? new CatalogGridCell('boolean', $value)
                : throw self::rule(Code::CATALOG_VALUE, self::RULE_DRIVER_VALUE),
            'date' => new CatalogGridCell('date', self::serverDate(self::driverText($value))),
            'time' => new CatalogGridCell('time', self::serverTime(self::driverText($value))),
            'timestamp' => new CatalogGridCell('datetime', self::serverDateTime(self::driverText($value))),
            'zoned' => throw self::rule(Code::CATALOG_VALUE, self::RULE_POSTGRES_ZONED),
            'bytea' => new CatalogGridCell('binary', self::driverBytes($value)),
            'text' => self::textCell($value),
            default => throw self::rule(Code::CATALOG_VALUE, self::RULE_NATIVE_TYPE),
        };
    }

    /**
     * The grid cell of one SQLite value, by its storage class: SQLite gives each value a class that is a cell kind
     * (INT-170), and a REAL is a Float64 cell (INT-183). binary is a blob.
     */
    private static function sqliteGridCell(mixed $value, bool $binary): CatalogGridCell
    {
        return match (true) {
            $value === null => new CatalogGridCell('null'),
            is_int($value) => new CatalogGridCell('integer', $value),
            is_float($value) => self::float64Cell($value),
            $binary => new CatalogGridCell('binary', self::driverBytes($value)),
            default => self::textCell($value),
        };
    }

    /** A text cell; a value that is not valid UTF-8 is its bytes (INT-153, INT-157). */
    private static function textCell(mixed $value): CatalogGridCell
    {
        $text = self::driverText($value);
        return self::isUtf8($text) ? new CatalogGridCell('text', $text) : new CatalogGridCell('binary', $text);
    }

    /** A rule that a value breaks, which the caller names by its column (INT-165). */
    private static function rule(string $code, string $text, ?\Throwable $cause = null): CatalogRule
    {
        return new CatalogRule($code, $text, $cause);
    }

    /** The error of a rule at the 1-based column n: `CODE: column n: text`, with the failure it keeps (INT-172). */
    private static function atColumn(CatalogRule $rule, int $column): OrmException
    {
        // A driver of one runtime does not tell which column it failed to decode, so INT-172 names none (INT-165).
        $text = $rule->getMessage() === self::RULE_DRIVER_DECODE ? $rule->getMessage()
            : "column $column: " . $rule->getMessage();
        return new OrmException($rule->ruleCode, $text, $rule->getPrevious());
    }

    /** The text of a driver value that the driver delivers as text (INT-171). */
    private static function driverText(mixed $value): string
    {
        if (!is_string($value)) {
            throw self::rule(Code::CATALOG_VALUE, self::RULE_DRIVER_VALUE);
        }
        return $value;
    }

    /**
     * The bytes of a binary driver value. PDO reads a PostgreSQL bytea as a stream, which is read to its end here; a
     * stream that cannot be read is INT-172 and keeps the failure of the read as its cause. PHP reports a failed read
     * as a notice and an empty result, and a user stream as an exception, so either one is the failure.
     */
    private static function driverBytes(mixed $value): string
    {
        if (is_string($value)) {
            return $value;
        }
        if (!is_resource($value)) {
            throw self::rule(Code::CATALOG_VALUE, self::RULE_DRIVER_VALUE);
        }
        // The failure is what the read throws, and otherwise the last error that it reports, as the extension reads it.
        $failure = null;
        set_error_handler(static function (int $severity, string $message) use (&$failure): bool {
            $failure = new \ErrorException($message, 0, $severity);
            return true;
        });
        try {
            $data = stream_get_contents($value);
        } catch (\Throwable $thrown) {
            $failure = $thrown;
            $data = false;
        } finally {
            restore_error_handler();
            fclose($value);
        }
        if ($failure !== null || $data === false) {
            throw self::rule(
                Code::CATALOG_VALUE,
                self::RULE_DRIVER_DECODE,
                $failure ?? new \UnexpectedValueException('stream_get_contents failed')
            );
        }
        return $data;
    }

    /** The bytes of a MySQL BIT(bits) value, which PDO delivers as an integer: ceil(bits / 8) bytes, big-endian. */
    private static function bitBytes(mixed $value, int $bits): string
    {
        if (is_string($value)) {
            return $value;
        }
        if (!is_int($value) || $bits < 1 || $bits > 64) {
            throw self::rule(Code::CATALOG_VALUE, self::RULE_DRIVER_VALUE);
        }
        return substr(pack('J', $value), 8 - intdiv($bits + 7, 8));
    }

    /** The text of a decimal: plain digits with an optional sign and fraction (INT-171). */
    private static function decimalText(mixed $value): string
    {
        $text = self::driverText($value);
        if (preg_match('/^-?\d+(\.\d+)?$/D', $text) !== 1) {
            throw self::rule(Code::CATALOG_VALUE, self::RULE_DRIVER_VALUE);
        }
        return $text;
    }

    /** The text of a PostgreSQL numeric, which writes NaN and the infinities as words (INT-169). */
    private static function postgresNumeric(mixed $value): string
    {
        if (in_array($value, ['NaN', 'Infinity', '-Infinity'], true)) {
            throw self::rule(Code::CATALOG_VALUE, self::RULE_POSTGRES_NUMERIC);
        }
        return self::decimalText($value);
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
        throw self::rule(Code::CATALOG_VALUE, self::RULE_DRIVER_VALUE);
    }

    /**
     * An integer cell; an UNSIGNED column holds its value as exact decimal digits, which PHP ints cannot hold past
     * PHP_INT_MAX. Text that is not the digits of a 64-bit integer is INT-171.
     */
    private static function integerCell(mixed $value, bool $unsigned): CatalogGridCell
    {
        if (is_int($value)) {
            return $unsigned ? new CatalogGridCell(
                'unsigned',
                sprintf('%u', $value)
            ) : new CatalogGridCell('integer', $value);
        }
        if (!is_string($value)) {
            throw self::rule(Code::CATALOG_VALUE, self::RULE_DRIVER_VALUE);
        }
        $value = self::unpadded($value);
        $n = filter_var($value, FILTER_VALIDATE_INT);
        if ($n !== false && !$unsigned) {
            return new CatalogGridCell('integer', $n);
        }
        // Digits beyond the signed range are an unsigned value, whatever the column reports (INT-157).
        if (self::isUnsignedDigits($value)) {
            return new CatalogGridCell('unsigned', $value);
        }
        throw self::rule(Code::CATALOG_VALUE, self::RULE_DRIVER_VALUE);
    }

    /**
     * The digits of a MySQL integer text without the leading zeros that the server pads a ZEROFILL value with to its
     * display width (00042 is 42); any other text is unchanged.
     */
    private static function unpadded(string $text): string
    {
        return preg_match('/^\d+$/D', $text) === 1 ? (ltrim($text, '0') === '' ? '0' : ltrim($text, '0')) : $text;
    }

    /**
     * The integer of a MySQL YEAR value (INT-166): 1901 to 2155, or 0 for the zero year. The server writes it in four
     * digits, 0000 for the zero year, and flags the column UNSIGNED, which does not make it an unsigned cell.
     */
    private static function yearNumber(mixed $value): int
    {
        if (is_int($value)) {
            return $value;
        }
        if (is_string($value) && preg_match('/^\d{4}$/D', $value) === 1) {
            return (int) $value;
        }
        throw self::rule(Code::CATALOG_VALUE, self::RULE_DRIVER_VALUE);
    }

    /** Whether a text is the decimal digits of an unsigned 64-bit integer, with no sign and no leading zero. */
    private static function isUnsignedDigits(string $text): bool
    {
        return preg_match('/^(0|[1-9]\d{0,19})$/D', $text) === 1
            && (strlen($text) < 20 || strcmp($text, '18446744073709551615') <= 0);
    }

    /**
     * The dbspec date YYYY-MM-DD of a date that the server writes: MySQL and PostgreSQL write YYYY-MM-DD, PostgreSQL a
     * year past 9999 with more digits, a date before the year 1 with BC and its infinities as words. A year outside
     * 1 to 9999 is INT-173, checked before the calendar of INT-174, and any other text INT-171.
     */
    private static function serverDate(string $text): string
    {
        if ($text === 'infinity' || $text === '-infinity') {
            throw self::rule(Code::GRID_TEMPORAL_VALUE, self::RULE_DATE_RANGE);
        }
        if (preg_match('/^(\d{4,})-(\d{2})-(\d{2})( BC)?$/D', $text, $m) !== 1) {
            throw self::rule(Code::CATALOG_VALUE, self::RULE_DRIVER_VALUE);
        }
        if (($m[4] ?? '') !== '') {
            throw self::rule(Code::GRID_TEMPORAL_VALUE, self::RULE_DATE_RANGE);
        }
        return self::calendarDate($m[1], $m[2], $m[3]);
    }

    /** A date of the year 1 to 9999 (INT-173) that is a date of the calendar (INT-174), as YYYY-MM-DD. */
    private static function calendarDate(string $year, string $month, string $day): string
    {
        if (strlen(ltrim($year, '0')) > 4 || (int) $year < 1) {
            throw self::rule(Code::GRID_TEMPORAL_VALUE, self::RULE_DATE_RANGE);
        }
        if (!checkdate((int) $month, (int) $day, (int) $year)) {
            throw self::rule(Code::GRID_TEMPORAL_VALUE, self::RULE_CALENDAR_DATE);
        }
        return sprintf('%04d-%s-%s', (int) $year, $month, $day);
    }

    /**
     * The dbspec time HH:MM:SS.ffffff of a time that the server writes. A MySQL TIME past a day, of three hour digits
     * or negative, and PostgreSQL 24:00:00 are INT-175; a text that is no time, or has a digit past six fraction
     * digits, is INT-171.
     */
    private static function serverTime(string $text): string
    {
        if (
            preg_match('/^(-?)(\d{2,}):(\d{2}):(\d{2})(?:\.(\d+))?$/D', $text, $m) !== 1
            || strlen($m[5] ?? '') > 6 || (int) $m[3] > 59 || (int) $m[4] > 59
        ) {
            throw self::rule(Code::CATALOG_VALUE, self::RULE_DRIVER_VALUE);
        }
        if ($m[1] === '-' || (int) $m[2] > 23) {
            throw self::rule(Code::GRID_TEMPORAL_VALUE, self::RULE_TIME_RANGE);
        }
        return sprintf('%02d:%s:%s.%s', (int) $m[2], $m[3], $m[4], str_pad($m[5] ?? '', 6, '0'));
    }

    /** The dbspec datetime YYYY-MM-DD HH:MM:SS.ffffff of a datetime that the server writes; its date comes first. */
    private static function serverDateTime(string $text): string
    {
        if ($text === 'infinity' || $text === '-infinity') {
            throw self::rule(Code::GRID_TEMPORAL_VALUE, self::RULE_DATE_RANGE);
        }
        if (preg_match('/^(\d{4,}-\d{2}-\d{2}) (\S+?)( BC)?$/D', $text, $m) !== 1) {
            throw self::rule(Code::CATALOG_VALUE, self::RULE_DRIVER_VALUE);
        }
        return self::serverDate($m[1] . ($m[3] ?? '')) . ' ' . self::serverTime($m[2]);
    }

    /**
     * Opens one transaction on the connection, runs fn and ends the transaction. SQLite sets query_only on every
     * session itself, so a read session cannot write and a write session is not left read-only.
     *
     * @template T
     * @param \Closure(\PDO): T $fn
     * @return T
     */
    private function session(bool $readOnly, \Closure $fn): mixed
    {
        $this->assertOpen();
        if ($this->streamLeft) {
            $this->closeConnection();
            $this->reopenUntil = hrtime(true) / 1e9 + self::REOPEN_SECONDS;
            $this->db = $this->openConnection();
            $this->streamLeft = false;
        }
        // A type of a past session may be gone, and its OID taken by another type.
        $this->pgTypeClasses = [];
        $this->pgSettings = null;
        $pdo = $this->db->pdo();
        try {
            if ($this->dialect === 'sqlite') {
                $pdo->exec('PRAGMA query_only = ' . ($readOnly ? 'ON' : 'OFF'));
            }
            if ($readOnly && $this->dialect === 'mysql') {
                // At REPEATABLE READ the information schema answers from the snapshot of the transaction, so a
                // descriptor read after the rows could not differ from the one read before them (INT-121).
                $pdo->exec('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            }
            $pdo->exec(self::beginSql($this->dialect, $readOnly));
        } catch (\PDOException $e) {
            throw $this->db->driverError($e);
        }
        try {
            if ($this->dialect === 'postgres') {
                try {
                    $pdo->exec(self::PG_FIXED_SETTINGS);
                } catch (\PDOException $e) {
                    throw $this->db->driverError($e);
                }
                $this->pgSettings = $this->pgOutputSettings($pdo);
            }
            if (!$readOnly && $this->dialect === 'mysql') {
                $this->mysqlPartialRevokesOff($pdo);
            }
            $value = $fn($pdo);
            $this->pgSettingsUnchanged($pdo);
        } catch (\Throwable $cause) {
            if ($this->streamLeft) {
                throw $cause;
            }
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

    private function assertOpen(): void
    {
        if ($this->closed) {
            throw new OrmException(Code::CATALOG_CLOSED, 'catalog connection is closed');
        }
    }

    /**
     * Rolls the transaction back and rethrows cause; a failed rollback is reported with cause as its previous error.
     */
    /** @return list<mixed> The values of the PostgreSQL output settings in the transaction of the session. */
    private function pgOutputSettings(\PDO $pdo): array
    {
        try {
            $st = $pdo->prepare('SELECT ' . self::PG_SETTING_COLUMNS);
            $st->execute();
            $rows = $st->fetchAll(\PDO::FETCH_NUM);
        } catch (\PDOException $e) {
            throw $this->db->driverError($e);
        }
        if (count($rows) !== 1) {
            throw new OrmException(Code::TABLE_METADATA_INVALID, 'current_setting returned ' . count($rows) . ' rows');
        }
        return $rows[0];
    }

    /**
     * Refuses a PostgreSQL session whose output settings, read after its rows and before its transaction ends, differ
     * from their values when the transaction began (INT-186): a change that no row carries, as in a result of no rows.
     * A local setting reverts when the transaction ends, so the check runs inside it.
     */
    private function pgSettingsUnchanged(\PDO $pdo): void
    {
        if ($this->pgSettings !== null && $this->pgOutputSettings($pdo) !== $this->pgSettings) {
            throw new OrmException(Code::CATALOG_VALUE, self::RULE_SETTING_CHANGED);
        }
    }

    /**
     * The statement of a PostgreSQL read of cells, run so that each row carries the output settings under which the
     * server writes it (INT-186): a MATERIALIZED CTE keeps a plan of its own, so the outer projection of a row runs
     * right before the server sends that row and runs its output functions. A read query may end with one semicolon
     * (validateReadOnly), which cannot stand inside the CTE.
     */
    private static function settingsRead(string $sql): string
    {
        $semicolon = null;
        self::words($sql, 'postgres', $semicolon);
        if ($semicolon !== null) {
            $sql = substr($sql, 0, $semicolon);
        }
        return "WITH catalog_read AS MATERIALIZED (\n" . $sql . "\n) SELECT catalog_read.*, " . self::PG_SETTING_COLUMNS
            . ' FROM catalog_read';
    }

    /**
     * The count of setting columns that a read of cells carries after its own columns (INT-186), and the read of the
     * statement: 0 and the statement itself off PostgreSQL or for a read that is not of cells.
     *
     * @return array{int, string}
     */
    private function cellsRead(string $sql, bool $cells): array
    {
        if (!$cells || $this->pgSettings === null) {
            return [0, $sql];
        }
        return [count($this->pgSettings), self::settingsRead($sql)];
    }

    /**
     * The metadata of the columns of a result without its setting columns (INT-186).
     *
     * @param list<array<string, mixed>> $metas
     * @return list<array<string, mixed>>
     */
    private static function withoutSettings(array $metas, int $settings): array
    {
        if (count($metas) < $settings) {
            throw new OrmException(Code::TABLE_METADATA_INVALID, 'the read returned ' . count($metas) . ' columns');
        }
        return array_slice($metas, 0, count($metas) - $settings);
    }

    private function rollback(\PDO $pdo, \Throwable $cause): never
    {
        try {
            $this->endTransaction($pdo);
        } catch (\PDOException $e) {
            throw OrmException::rollback($cause, $this->db->driverError($e));
        }
        throw $cause;
    }

    /**
     * Sends ROLLBACK when the transaction is still open. SQLite rolls a transaction back by itself after some
     * errors, such as RAISE(ROLLBACK) or an I/O error, and a ROLLBACK then fails with "no transaction is active"
     * (INT-155).
     */
    private function endTransaction(\PDO $pdo): void
    {
        if ($this->dialect !== 'sqlite' || $pdo->inTransaction()) {
            $pdo->exec('ROLLBACK');
        }
    }

    private function endRead(\PDO $pdo): void
    {
        try {
            $this->endTransaction($pdo);
        } catch (\PDOException $e) {
            throw new OrmException(
                Code::ROW_ROLLBACK_FAILED,
                'rollback: ' . $this->db->driverError($e)->getMessage(),
                $e
            );
        }
    }

    /** Reports a rejected or unknown commit. The rejected commit rolls back; an unknown outcome is never retried. */
    private function commitFailed(\PDO $pdo, \PDOException $e): never
    {
        $mapped = $this->db->driverError($e);
        if (
            in_array(
                $mapped->code_,
                [Code::DUPLICATE_KEY, Code::FOREIGN_KEY, Code::CONSTRAINT, Code::DEADLOCK],
                true
            )
        ) {
            $this->rollback($pdo, new OrmException(
                Code::ROW_COMMIT_REJECTED,
                'native commit rejected: ' . $mapped->getMessage(),
                $mapped
            ));
        }
        // The outcome is unknown. Ending the server transaction is the discard of the connection that the Go client
        // does. Whether that ROLLBACK succeeds does not change the outcome, which is reported as unknown: a failed
        // ROLLBACK is retained in the rollback property of the indeterminate error.
        $message = 'commit outcome unknown; do not retry: ' . $mapped->getMessage();
        $rollback = null;
        try {
            $this->endTransaction($pdo);
        } catch (\PDOException $rollbackFailure) {
            $rollback = $this->db->driverError($rollbackFailure);
            $message .= '; rollback failed: ' . $rollback->getMessage();
            // The connection is gone with the commit, so the next call opens a new one (INT-118).
            $this->streamLeft = true;
        }
        throw new OrmException(Code::ROW_COMMIT_INDETERMINATE, $message, $mapped, $rollback);
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
     * Fetches rows within the shared row and byte budgets. The row limit is checked before a row is converted; the
     * transform then converts the row, and the byte budget counts its converted cells (INT-115): a grid cell by
     * gridCellSize, the text of a decimal or temporal cell rather than the driver value it came from.
     *
     * @param \Closure(): (list<mixed>|false) $fetch
     * @param int $maxRows
     * @param int $maxBytes
     * @param (\Closure(list<mixed>): list<mixed>)|null $transform
     * @param int $settings the count of setting columns after the columns of each row, checked before the row (INT-186)
     * @return list<list<mixed>>
     */
    private function boundedRows(
        \Closure $fetch,
        int $maxRows,
        int $maxBytes,
        ?\Closure $transform = null,
        int $settings = 0
    ): array {
        $rows = [];
        $budget = 0;
        while (($row = $fetch()) !== false) {
            if (count($rows) === $maxRows) {
                throw new OrmException(Code::CATALOG_LIMIT, "result has more than $maxRows rows");
            }
            if ($settings > 0) {
                // The settings of a row are checked before any of its values (INT-186); they are no values of it.
                $width = count($row) - $settings;
                if (array_slice($row, $width) !== $this->pgSettings) {
                    throw new OrmException(Code::CATALOG_VALUE, self::RULE_SETTING_CHANGED);
                }
                $row = array_slice($row, 0, $width);
            }
            $cells = $transform === null ? $row : $transform($row);
            foreach ($cells as $cell) {
                $budget += $cell instanceof CatalogGridCell
                    ? self::gridCellSize($cell)
                    : (is_string($cell) ? strlen($cell) : 8);
            }
            if ($budget > $maxBytes) {
                throw new OrmException(Code::CATALOG_LIMIT, "result has more than $maxBytes bytes of values");
            }
            $rows[] = $cells;
        }
        return $rows;
    }

    /**
     * The bytes that a grid cell counts against a result budget (INT-115): the bytes of a text, decimal, date, time,
     * datetime or binary cell and 8 for every other cell, null included.
     */
    private static function gridCellSize(CatalogGridCell $cell): int
    {
        return match ($cell->kind) {
            'text', 'decimal', 'date', 'time', 'datetime', 'binary' => strlen((string) $cell->value),
            default => 8,
        };
    }

    /**
     * The MySQL buffering attribute: PHP 8.5 names it on Pdo\Mysql and deprecates the PDO constant.
     */
    private static function bufferedQueryAttribute(): int
    {
        return class_exists(\Pdo\Mysql::class)
            ? \Pdo\Mysql::ATTR_USE_BUFFERED_QUERY
            : \PDO::MYSQL_ATTR_USE_BUFFERED_QUERY;
    }

    /**
     * @param list<mixed> $args
     * @param bool $streamed reads the rows as they are fetched: MySQL buffers a result by default, which would read a
     *                       whole result before a row or byte budget can stop it
     */
    private function prepareQuery(\PDO $pdo, string $sql, array $args, bool $streamed = false): \PDOStatement
    {
        // The driver reads the buffering mode when it executes, so a streamed read sets it on the connection first.
        $unbuffered = $streamed && $this->dialect === 'mysql';
        if ($unbuffered) {
            $pdo->setAttribute(self::bufferedQueryAttribute(), false);
        }
        try {
            // PDO binds only the ? and :name placeholders, so a PostgreSQL $n is rewritten to ? and the parameters are
            // ordered by the placeholders in the order they occur (a repeated $n binds its value again).
            if ($this->dialect === 'postgres' && preg_match('/\$\d+/', $sql) === 1) {
                $ordered = [];
                $sql = preg_replace_callback(
                    '/\$(\d+)/',
                    static function (array $m) use ($args, &$ordered): string {
                        $at = (int) $m[1] - 1;
                        if (!array_key_exists($at, $args)) {
                            throw new OrmException(Code::DRIVER, "placeholder \${$m[1]} has no parameter");
                        }
                        $ordered[] = $args[$at];
                        return '?';
                    },
                    $sql
                );
                $args = $ordered;
            }
            $statement = $pdo->prepare($sql);
            // Each parameter keeps its PHP type where the driver binds it: execute() would bind every value as a
            // string, and an integer would come back as text. PostgreSQL's execute() binds its parameters as text,
            // which its casts in the statement read; but it binds a PHP false as the empty string, which a boolean
            // column refuses, so a PostgreSQL statement with a bool binds the bool as a bool and the others as text or
            // NULL (DIA-29).
            if ($this->dialect === 'postgres') {
                if (!in_array(true, array_map(is_bool(...), $args), true)) {
                    $statement->execute($args);
                    return $statement;
                }
                foreach ($args as $at => $arg) {
                    $statement->bindValue($at + 1, $arg, match (true) {
                        is_bool($arg) => \PDO::PARAM_BOOL,
                        $arg === null => \PDO::PARAM_NULL,
                        default => \PDO::PARAM_STR,
                    });
                }
                $statement->execute();
                return $statement;
            }
            foreach ($args as $at => $arg) {
                $statement->bindValue($at + 1, $arg, match (true) {
                    is_int($arg) => \PDO::PARAM_INT,
                    is_bool($arg) => \PDO::PARAM_BOOL,
                    $arg === null => \PDO::PARAM_NULL,
                    default => \PDO::PARAM_STR,
                });
            }
            $statement->execute();
        } finally {
            if ($unbuffered) {
                $pdo->setAttribute(self::bufferedQueryAttribute(), true);
            }
        }
        return $statement;
    }

    /**
     * @param list<list<mixed>> $rows
     * @param list<array{int, mixed}> $changes
     * @return list<mixed>
     */
    private static function verifyInsertedRow(
        array $rows,
        array $changes,
        string $countCode,
        string $countMessage,
        CatalogTableMetadata $descriptor
    ): array {
        if (count($rows) !== 1) {
            throw new OrmException($countCode, $countMessage);
        }
        self::assertStoredValues($rows[0], $changes, $descriptor);
        return $rows[0];
    }

    /**
     * ROW_WRITE_MISMATCH when a cell of the stored row differs from the value that the insert wrote to it.
     *
     * @param list<mixed> $row
     * @param list<array{int, mixed}> $changes
     */
    private static function assertStoredValues(array $row, array $changes, CatalogTableMetadata $descriptor): void
    {
        foreach ($changes as [$index, $value]) {
            if (self::cellKey($row[$index]) !== self::cellKey($value)) {
                throw new OrmException(
                    Code::ROW_WRITE_MISMATCH,
                    'stored inserted values of "' . $descriptor->columns[$index]->name . '" differ'
                );
            }
        }
    }

    /**
     * @param array{names: list<string>, types: list<string>, rows: list<list<mixed>>} $result
     * @return list<list<mixed>>
     */
    private function rowsForDescriptor(\PDO $pdo, array $result, CatalogTableMetadata $descriptor): array
    {
        self::sameNames($result['names'], $descriptor, Code::TABLE_PAGE_METADATA_CHANGED);
        return $this->describedRows($pdo, $result, $descriptor);
    }

    /**
     * Runs a bounded query. It fails when the result has more than maxRows rows or more than maxBytes of values.
     * With $convert, each value becomes $convert(value, native type, 0-based column) as it is read, and the budget
     * counts the converted value. oids holds the PostgreSQL type OID of each column, null on the other databases.
     *
     * @param list<mixed> $args
     * @param ?\Closure(mixed, string, int): mixed $convert
     * @return array{names: list<string>, types: list<string>, oids: list<?int>, rows: list<list<mixed>>}
     */
    private function query(
        \PDO $pdo,
        string $sql,
        array $args,
        int $maxRows,
        int $maxBytes,
        ?\Closure $convert = null,
        bool $cells = false
    ): array {
        try {
            // A cursor holds a read, never a write: an insert with no assignment has no argument either (INT-123).
            $cursor = $this->dialect === 'postgres' && $args === [] && !str_starts_with($sql, 'INSERT ');
            [$settings, $sql] = $this->cellsRead($sql, $cells);
            if ($cursor) {
                return $this->cursorQuery($pdo, $sql, $maxRows, $maxBytes, $convert, $settings);
            }
            $connectionId = $this->dialect === 'mysql' ? $this->mysqlConnectionId($pdo) : null;
            $st = $this->prepareQuery($pdo, $sql, $args, true);
            return $this->readStatement($st, $connectionId, function () use (
                $pdo,
                $st,
                $maxRows,
                $maxBytes,
                $convert,
                $settings
            ): array {
                $metas = self::withoutSettings(self::columnMetas($st), $settings);
                $types = array_map(
                    static fn (array $meta): string => strtoupper((string) ($meta['native_type'] ?? '')),
                    $metas
                );
                $fetch = static fn (): array|false => $st->fetch(\PDO::FETCH_NUM);
                if ($this->dialect === 'postgres' && !self::pgBuiltins($metas)) {
                    // A lookup of a type runs a statement, which ends this one, so its rows are read first.
                    $fetch = self::bufferedFetch($st);
                    self::refuseMultirange($this->pgClasses($pdo, $metas));
                }
                $rows = $this->boundedRows(
                    $fetch,
                    $maxRows,
                    $maxBytes,
                    $convert === null ? null
                        : static fn (array $row): array => array_map($convert, $row, $types, array_keys($row)),
                    $settings
                );
                return [
                    'names' => self::metaNames($metas),
                    'types' => $types,
                    'oids' => array_map(self::oidOf(...), $metas),
                    'rows' => $rows,
                ];
            });
        } catch (\PDOException $e) {
            throw $this->db->driverError($e);
        }
    }

    /**
     * Reads a PostgreSQL result without parameters through a cursor, in chunks of 256 rows. PDO's PostgreSQL driver
     * would buffer the whole result before a budget can stop it; a stopped read leaves the rest of the cursor unread,
     * and the cursor ends with the transaction.
     *
     * @return array{names: list<string>, types: list<string>, oids: list<?int>, rows: list<list<mixed>>}
     */
    private function cursorQuery(
        \PDO $pdo,
        string $sql,
        int $maxRows,
        int $maxBytes,
        ?\Closure $convert = null,
        int $settings = 0
    ): array {
        $names = [];
        $types = [];
        $oids = [];
        $rows = $this->cursorRead(
            $pdo,
            $sql,
            $maxRows,
            $maxBytes,
            function (\PDOStatement $first) use ($pdo, &$names, &$types, &$oids, $settings): void {
                $metas = self::withoutSettings(self::columnMetas($first), $settings);
                foreach ($metas as $meta) {
                    $names[] = (string) ($meta['name'] ?? '');
                    $types[] = strtoupper((string) ($meta['native_type'] ?? ''));
                    $oids[] = self::oidOf($meta);
                }
                if (!self::pgBuiltins($metas)) {
                    self::refuseMultirange($this->pgClasses($pdo, $metas));
                }
            },
            $convert === null ? null : static function (\PDOStatement $st, array $row) use (&$types, $convert): array {
                return array_map($convert, $row, $types, array_keys($row));
            },
            $settings
        );
        return ['names' => $names, 'types' => $types, 'oids' => $oids, 'rows' => $rows];
    }

    /** The PostgreSQL type OID of a column's metadata, which only a PostgreSQL statement reports. */
    private static function oidOf(array $meta): ?int
    {
        return isset($meta['pgsql:oid']) ? (int) $meta['pgsql:oid'] : null;
    }

    /** The PostgreSQL grid query without parameters, read through a cursor. */
    private function cursorGrid(\PDO $pdo, string $sql, int $maxRows, int $maxBytes, int $settings): array
    {
        $names = [];
        $classes = [];
        $rows = $this->cursorRead(
            $pdo,
            $sql,
            $maxRows,
            $maxBytes,
            function (\PDOStatement $first) use ($pdo, &$names, &$classes, $settings): void {
                $metas = self::withoutSettings(self::columnMetas($first), $settings);
                $names = self::metaNames($metas);
                $classes = $this->pgClasses($pdo, $metas);
                self::refuseMultirange($classes);
            },
            static function (\PDOStatement $st, array $row) use (&$classes): array {
                $cells = [];
                foreach ($row as $i => $value) {
                    try {
                        $cells[] = self::postgresGridCell($value, $classes[$i]);
                    } catch (CatalogRule $rule) {
                        throw self::atColumn($rule, $i + 1);
                    }
                }
                return $cells;
            },
            $settings
        );
        return ['names' => $names, 'rows' => $rows];
    }

    /**
     * Reads the rows of one statement through a cursor in chunks of 256 rows. $begin gets the first chunk's statement
     * once, after its rows are read, for the column metadata; $cells, when given, maps each row with the statement of
     * its chunk. A budget stop ends the read after its chunk, and the transaction ends the cursor.
     *
     * @param \Closure(\PDOStatement): void $begin
     * @param (\Closure(\PDOStatement, list<mixed>): list<mixed>)|null $cells
     * @return list<list<mixed>>
     */
    private function cursorRead(
        \PDO $pdo,
        string $sql,
        int $maxRows,
        int $maxBytes,
        \Closure $begin,
        ?\Closure $cells,
        int $settings = 0,
    ): array {
        $cursor = 'orm_read_' . bin2hex(random_bytes(6));
        $pdo->exec("DECLARE $cursor NO SCROLL CURSOR FOR $sql");
        $chunk = [];
        $ended = false;
        $described = false;
        $current = null;
        try {
            $rows = $this->boundedRows(
                function () use ($pdo, $cursor, $begin, &$chunk, &$ended, &$described, &$current): array|false {
                    if ($chunk === []) {
                        if ($ended) {
                            return false;
                        }
                        $current = $pdo->prepare("FETCH FORWARD 256 FROM $cursor");
                        $current->execute();
                        $chunk = $current->fetchAll(\PDO::FETCH_NUM);
                        // The chunk is read first: begin may run a statement of its own, which ends this one.
                        if (!$described) {
                            $begin($current);
                            $described = true;
                        }
                        if (count($chunk) < 256) {
                            $ended = true;
                        }
                        if ($chunk === []) {
                            return false;
                        }
                    }
                    return array_shift($chunk);
                },
                $maxRows,
                $maxBytes,
                $cells === null ? null : function (array $row) use ($cells, &$current): array {
                    return $cells($current, $row);
                },
                $settings
            );
        } catch (\Throwable $primary) {
            // After a stop or a failed transaction the cursor may already be gone; the transaction ends it either way.
            // A CLOSE that fails here does not replace the primary error: it is recorded on it as cleanup.
            try {
                $pdo->exec("CLOSE $cursor");
            } catch (\PDOException $closeError) {
                throw OrmException::withCleanup($primary, $this->db->driverError($closeError));
            }
            throw $primary;
        }
        try {
            $pdo->exec("CLOSE $cursor");
        } catch (\PDOException $e) {
            throw $this->db->driverError($e);
        }
        return $rows;
    }

    /** @param list<mixed> $args Runs one statement and returns the number of rows it affected. */
    private function exec(\PDO $pdo, string $sql, array $args): int
    {
        try {
            return $this->prepareQuery($pdo, $sql, $args)->rowCount();
        } catch (\PDOException $e) {
            throw $this->db->driverError($e);
        }
    }

    /**
     * Describes a table inside the session. Callers that need a stable descriptor describe it again inside the same
     * session and compare the two.
     *
     * @param array{namespace: string, name: string} $ref
     */
    private function describe(\PDO $pdo, array $ref): CatalogTableMetadata
    {
        if ($this->dialect === 'sqlite' && $ref['namespace'] !== 'main') {
            throw new OrmException(Code::TABLE_NAMESPACE_UNSUPPORTED, 'SQLite requires main');
        }
        $kindRaw = $this->query(
            $pdo,
            self::KIND_SQL[$this->dialect],
            [$ref['namespace'], $ref['name']],
            2,
            self::METADATA_BYTES
        );
        if ($kindRaw['rows'] === []) {
            throw new OrmException(Code::TABLE_NOT_FOUND, $ref['namespace'] . '.' . $ref['name']);
        }
        if (count($kindRaw['rows']) !== 1 || count($kindRaw['rows'][0]) !== 1) {
            throw new OrmException(Code::TABLE_METADATA_INVALID, 'ambiguous relation');
        }
        $kind = self::kind($this->dialect, self::text($kindRaw['rows'][0][0]));

        // SQLite table-valued pragmas take the table name first and the schema second.
        $args = match ($this->dialect) {
            'sqlite' => [$ref['name'], $ref['namespace']],
            'mysql' => [$ref['namespace'], $ref['name'], $ref['namespace'], $ref['name']],
            default => [$ref['namespace'], $ref['name']],
        };
        $raw = $this->query($pdo, self::COLUMNS_SQL[$this->dialect], $args, self::METADATA_ROWS, self::METADATA_BYTES);

        $columns = [];
        $keys = [];
        foreach ($raw['rows'] as $row) {
            if (count($row) !== 8) {
                throw new OrmException(Code::TABLE_METADATA_INVALID, 'column shape of ' . count($row) . ' values');
            }
            $column = self::columnRow($row);
            if ($this->db->server() === 'mariadb') {
                $column = self::mariadbColumn($column);
            }
            foreach ($columns as $existing) {
                if ($existing->name === $column->name) {
                    throw new OrmException(
                        Code::TABLE_METADATA_INVALID,
                        'duplicate column ' . Message::quote($column->name),
                    );
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

        // A SQLite INTEGER primary key without a separate primary-key index is the rowid alias: never NULL, generated
        // by the database.
        if (
            $this->dialect === 'sqlite' && $kind === 'table' && count($keys) === 1
            && strcasecmp($columns[$keys[0][1]]->nativeType, 'INTEGER') === 0
        ) {
            $indexRaw = $this->query(
                $pdo,
                "SELECT count(*) FROM pragma_index_list(?,?) WHERE origin='pk'",
                $args,
                1,
                self::METADATA_BYTES
            );
            if (count($indexRaw['rows']) !== 1 || count($indexRaw['rows'][0]) !== 1) {
                throw new OrmException(Code::TABLE_METADATA_INVALID, 'primary index count');
            }
            if (self::intValue($indexRaw['rows'][0][0]) === 0) {
                $old = $columns[$keys[0][1]];
                $columns[$keys[0][1]] = new CatalogColumn(
                    $old->name,
                    $old->nativeType,
                    false,
                    $old->generated,
                    true,
                    $old->defaultExpression,
                    $old->expressionDefault
                );
            }
        }

        // On SQLite the declared precision of a TIME or DATETIME column is read from its dbspec CHECK (Go's
        // checkPrecision).
        if ($this->dialect === 'sqlite' && $kind === 'table') {
            $definition = $this->query(
                $pdo,
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
                [$ref['name']],
                1,
                self::METADATA_BYTES
            );
            $tableSql = $definition['rows'][0][0] ?? null;
            if (is_string($tableSql)) {
                foreach ($columns as $i => $column) {
                    if (!in_array(strtoupper($column->nativeType), ['TIME', 'DATETIME'], true)) {
                        continue;
                    }
                    $precision = self::checkPrecision($tableSql, $column->name);
                    if ($precision !== null) {
                        $columns[$i] = new CatalogColumn(
                            $column->name,
                            $column->nativeType,
                            $column->nullable,
                            $column->generated,
                            $column->automaticKey,
                            $column->defaultExpression,
                            $column->expressionDefault,
                            $precision,
                        );
                    }
                }
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
        return implode(
            ' AND ',
            array_map(fn (string $name): string => self::quote($name, $this->dialect) . '=?', $metadata->primaryKey)
        );
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
            default => throw new OrmException(
                Code::TABLE_KIND_UNSUPPORTED,
                'relation kind ' . Message::quote($native) . " of $dialect",
            ),
        };
    }

    /** @param array<int, mixed> $row */
    private static function columnRow(array $row): CatalogColumn
    {
        $name = self::text($row[0]);
        self::checkName($name);
        $native = self::text($row[1]);
        if ($row[6] !== null && !is_string($row[6])) {
            throw new OrmException(
                Code::TABLE_METADATA_INVALID,
                "default expression of column " . Message::quote($name) . " is not text"
            );
        }
        return new CatalogColumn(
            $name,
            $native,
            self::boolValue($row[2]),
            self::boolValue($row[3]),
            self::boolValue($row[5]),
            $row[6],
            self::boolValue($row[7])
        );
    }

    /**
     * A column of a MariaDB server, whose COLUMN_DEFAULT is SQL text and whose EXTRA marks no expression default, with
     * the default of the MySQL form (DIA-205): 'NULL' is no default, a quoted literal its value, a number itself, and
     * any other text an expression; a quoted text that is not one whole literal is TABLE_METADATA_INVALID.
     */
    private static function mariadbColumn(CatalogColumn $column): CatalogColumn
    {
        try {
            [$default, $expression] = Dbspec\MysqlCatalog::mariadbCatalogDefault($column->defaultExpression);
        } catch (\RuntimeException $e) {
            throw new OrmException(
                Code::TABLE_METADATA_INVALID,
                "column " . Message::quote($column->name) . ": {$e->getMessage()}",
                $e
            );
        }
        return new CatalogColumn(
            $column->name,
            $column->nativeType,
            $column->nullable,
            $column->generated,
            $column->automaticKey,
            $default,
            $expression
        );
    }

    private static function text(mixed $value): string
    {
        if (!is_string($value)) {
            throw new OrmException(Code::TABLE_METADATA_INVALID, 'expected text');
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
        throw new OrmException(Code::TABLE_METADATA_INVALID, 'expected a boolean');
    }

    /** An integer of a metadata row: a native integer, or text that holds one. */
    private static function intValue(mixed $value): int
    {
        $n = is_string($value) ? filter_var($value, FILTER_VALIDATE_INT) : $value;
        if (!is_int($n)) {
            throw new OrmException(Code::TABLE_METADATA_INVALID, 'expected an integer');
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

    private static function samePageDescriptor(CatalogTableMetadata $a, CatalogTableMetadata $b): bool
    {
        return $a == $b;
    }

    /**
     * The catalog value of one value of a read query: a MySQL or PostgreSQL date, time or datetime is the text of its
     * grid cell (INT-153), and any other value its plain conversion. A broken rule names its 1-based column.
     */
    private function queryValue(mixed $value, string $native, int $column): mixed
    {
        try {
            if ($value === null) {
                return null;
            }
            return match (self::temporalKind($this->dialect, $native)) {
                'date' => self::serverDate(self::driverText($value)),
                'time' => self::serverTime(self::driverText($value)),
                'datetime' => self::serverDateTime(self::driverText($value)),
                default => self::value($value, $native, $this->dialect),
            };
        } catch (CatalogRule $rule) {
            throw self::atColumn($rule, $column + 1);
        }
    }

    /**
     * Converts the rows of a read of a described table: tablePage, the lookup by key and the rows of a write. Each
     * value takes the conversion of its column (describedReader), row by row and in column order within a row, so a
     * broken rule names the first value that breaks one, by the position of its column among the described columns
     * (INT-165).
     *
     * @param array{names: list<string>, types: list<string>, oids: list<?int>, rows: list<list<mixed>>} $raw
     * @return list<list<mixed>>
     */
    private function describedRows(\PDO $pdo, array $raw, CatalogTableMetadata $metadata): array
    {
        if (count($metadata->columns) !== count($raw['names'])) {
            throw new OrmException(
                Code::TABLE_METADATA_INVALID,
                count($metadata->columns) . ' native types for ' . count($raw['names']) . ' columns'
            );
        }
        $readers = [];
        foreach ($metadata->columns as $i => $column) {
            $readers[] = $this->describedReader($pdo, $column, $raw['oids'][$i] ?? null);
        }
        $out = [];
        foreach ($raw['rows'] as $row) {
            $converted = [];
            foreach ($row as $i => $value) {
                try {
                    $converted[] = $value === null ? null : $readers[$i]($value);
                } catch (CatalogRule $rule) {
                    throw self::atColumn($rule, $i + 1);
                }
            }
            $out[] = $converted;
        }
        return $out;
    }

    /**
     * The conversion of the values of one described column, which is not NULL: the rule of its native type (INT-167 to
     * INT-170, INT-185), a temporal value in its declared precision, a boolean (INT-182), and the plain conversion of
     * value() otherwise. On PostgreSQL a type that no type text names takes the class of its result OID (pgClass).
     *
     * @return \Closure(mixed): mixed
     */
    private function describedReader(\PDO $pdo, CatalogColumn $column, ?int $oid): \Closure
    {
        $native = $column->nativeType;
        $dialect = $this->dialect;
        $plain = static fn (mixed $value): mixed => self::value($value, $native, $dialect);
        $refuse = static fn (string $code, string $text): \Closure
            => static fn (mixed $value): never => throw self::rule($code, $text);
        if ($dialect === 'sqlite') {
            // SQLite refuses no value for the type that its column declares (INT-184): only a dbspec temporal or
            // boolean column has a rule of its own.
            $kind = match (strtoupper(trim($native))) {
                'DATE' => 'date',
                'TIME' => 'time',
                'DATETIME' => 'datetime',
                default => null,
            };
            $precision = $column->checkPrecision ?? 0;
            return match (true) {
                $kind !== null => static fn (mixed $value): string => self::sqliteTemporal($value, $kind, $precision),
                strtolower(trim($native)) === 'boolean' => self::describedBoolean(...),
                default => $plain,
            };
        }
        $class = $dialect === 'mysql' ? self::mysqlColumnClass($native) : (self::pgColumnClass($native)
            ?? ($oid === null ? 'refused' : $this->pgClass($pdo, $oid)));
        return match ($class) {
            'year' => self::yearNumber(...),
            'mysql_timestamp' => $refuse(Code::CATALOG_VALUE, self::RULE_MYSQL_TIMESTAMP),
            'zoned' => $refuse(Code::CATALOG_VALUE, self::RULE_POSTGRES_ZONED),
            'refused', 'multirange' => $refuse(Code::CATALOG_VALUE, self::RULE_NATIVE_TYPE),
            'bool' => self::describedBoolean(...),
            'bit' => static fn (mixed $value): string => self::bitBytes($value, self::declaredWidth($native)),
            'spatial' => self::driverBytes(...),
            // An enum, an array, a range or a composite of a text cell is the text that the server writes.
            'text' => self::driverText(...),
            'numeric' => static fn (mixed $value): string => self::postgresNumeric($value),
            'date', 'time', 'datetime', 'timestamp' => static fn (mixed $value): string
                => self::describedServerTemporal(
                    self::driverText($value),
                    $class === 'timestamp' ? 'datetime' : $class,
                    self::declaredTemporalPrecision($dialect, $native)
                ),
            default => $plain,
        };
    }

    /**
     * The class of a MySQL column type, as information_schema writes it: a type of its own rule, a temporal kind, a
     * boolean, BIT or spatial bytes (INT-185), plain for every other type of a cell, and refused for a type that has
     * none (INT-170).
     */
    private static function mysqlColumnClass(string $nativeType): string
    {
        $type = strtolower(trim($nativeType));
        if ($type === 'tinyint(1)') {
            return 'bool';
        }
        return match (preg_split('/[( ]/', $type)[0]) {
            'year' => 'year',
            'timestamp' => 'mysql_timestamp',
            'date' => 'date',
            'time' => 'time',
            'datetime' => 'datetime',
            'bit' => 'bit',
            'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon',
            'geometrycollection', 'geomcollection' => 'spatial',
            'tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'float', 'double', 'decimal', 'char',
            'varchar', 'binary', 'varbinary', 'tinytext', 'text', 'mediumtext', 'longtext', 'tinyblob', 'blob',
            'mediumblob', 'longblob', 'enum', 'set', 'json' => 'plain',
            default => 'refused',
        };
    }

    /**
     * The class of a PostgreSQL column type that format_type writes for a built-in type, or null for a type that it
     * writes by its own name (an array, an enum, a domain, a range, a composite or any type of no built-in name).
     */
    private static function pgColumnClass(string $nativeType): ?string
    {
        $type = preg_replace('/\(\d+(,\d+)?\)/', '', strtolower(trim($nativeType)));
        return match ($type) {
            'smallint', 'integer', 'bigint', 'real', 'double precision', 'bytea' => 'plain',
            'numeric' => 'numeric',
            'boolean' => 'bool',
            'date' => 'date',
            'time without time zone' => 'time',
            'timestamp without time zone' => 'datetime',
            'time with time zone', 'timestamp with time zone' => 'zoned',
            'text', 'character varying', 'character', '"char"', 'name', 'uuid', 'json', 'jsonb', 'xml', 'bit',
            'bit varying', 'inet', 'cidr', 'macaddr', 'macaddr8', 'tsvector', 'tsquery', 'pg_lsn', 'oid' => 'plain',
            default => null,
        };
    }

    /** The classes of the columns of a PostgreSQL result, by the type OID of each (pgClass). */
    private function pgClasses(\PDO $pdo, array $metas): array
    {
        return array_map(
            fn (array $meta): string => isset($meta['pgsql:oid']) ? $this->pgClass($pdo, (int) $meta['pgsql:oid'])
                : 'refused',
            $metas
        );
    }

    /**
     * Refuses a PostgreSQL result with a column of a multirange type, or of a type that holds one, by its type and
     * before any value, NULL or not (INT-185): the first such column is INT-170.
     *
     * @param list<string> $classes
     */
    private static function refuseMultirange(array $classes): void
    {
        $at = array_search('multirange', $classes, true);
        if ($at !== false) {
            throw self::atColumn(self::rule(Code::CATALOG_VALUE, self::RULE_NATIVE_TYPE), $at + 1);
        }
    }

    /**
     * Reads every row of a statement now, as lists, and returns a fetch that gives them one at a time and false past
     * the last, so that another statement can run before the rows are read.
     *
     * @return \Closure(): (list<mixed>|false)
     */
    private static function bufferedFetch(\PDOStatement $st): \Closure
    {
        $buffered = $st->fetchAll(\PDO::FETCH_NUM);
        $next = 0;
        return static function () use ($buffered, &$next): array|false {
            return $buffered[$next++] ?? false;
        };
    }

    /** Whether each column of a PostgreSQL result has a built-in type, whose class needs no lookup. */
    private static function pgBuiltins(array $metas): bool
    {
        foreach ($metas as $meta) {
            if (!isset($meta['pgsql:oid'], self::PG_TYPE_CLASSES[(int) $meta['pgsql:oid']])) {
                return false;
            }
        }
        return true;
    }

    /**
     * The class of a PostgreSQL type by its OID (INT-185): the class of a built-in type, the class of the base type of
     * a domain, text for an enum, and for an array, a range, a multirange or a composite text when every element or
     * field type writes a text that no setting changes, refused otherwise (pgContainer). Any other type is refused
     * (INT-170). A type that is not built in is looked up in pg_type; the lookup runs a statement, so a caller reads
     * the rows of its own statement before.
     */
    private function pgClass(\PDO $pdo, int $oid): string
    {
        if (isset(self::PG_TYPE_CLASSES[$oid])) {
            return self::PG_TYPE_CLASSES[$oid];
        }
        if (isset($this->pgTypeClasses[$oid])) {
            return $this->pgTypeClasses[$oid];
        }
        // A type that contains itself is refused.
        $this->pgTypeClasses[$oid] = 'refused';
        $type = $this->pgRows(
            $pdo,
            'SELECT t.typtype::text, t.typcategory::text, t.typelem::int8, t.typbasetype::int8, t.typrelid::int8, '
                . '(SELECT r.rngsubtype::int8 FROM pg_range r WHERE r.rngtypid = t.oid OR r.rngmultitypid = t.oid) '
                . 'FROM pg_type t WHERE t.oid = ?',
            [$oid]
        )[0] ?? null;
        $class = match (true) {
            $type === null => 'refused',
            $type[0] === 'e' => 'text',
            $type[0] === 'd' => $this->pgClass($pdo, (int) $type[3]),
            $type[0] === 'b' && $type[1] === 'A' && (int) $type[2] !== 0
                => self::pgContainer([$this->pgClass($pdo, (int) $type[2])]),
            // A multirange is refused by its type (INT-185).
            $type[0] === 'm' => 'multirange',
            $type[0] === 'r' && $type[5] !== null => self::pgContainer([$this->pgClass($pdo, (int) $type[5])]),
            $type[0] === 'c' => self::pgContainer(array_map(
                fn (array $field): string => $this->pgClass($pdo, (int) $field[0]),
                $this->pgRows(
                    $pdo,
                    'SELECT atttypid::int8 FROM pg_attribute WHERE attrelid = ? AND attnum > 0 AND NOT attisdropped',
                    [(int) $type[4]]
                )
            )),
            default => 'refused',
        };
        return $this->pgTypeClasses[$oid] = $class;
    }

    /**
     * The class of an array, a range or a composite of the given element or field classes: a text cell when the text
     * output of each is that of a type that no setting changes (an integer, a numeric, a boolean or a text), refused
     * otherwise: a float follows extra_float_digits, a date or a time DateStyle, and bytea bytea_output (INT-185).
     *
     * @param list<string> $classes
     */
    private static function pgContainer(array $classes): string
    {
        if (in_array('multirange', $classes, true)) {
            return 'multirange';
        }
        foreach ($classes as $class) {
            if (!in_array($class, ['int', 'numeric', 'bool', 'text'], true)) {
                return 'refused';
            }
        }
        return 'text';
    }

    /**
     * The rows of a catalog statement of PostgreSQL types.
     *
     * @param list<mixed> $args
     * @return list<list<mixed>>
     */
    private function pgRows(\PDO $pdo, string $sql, array $args): array
    {
        try {
            $st = $pdo->prepare($sql);
            $st->execute($args);
            $rows = $st->fetchAll(\PDO::FETCH_NUM);
            $st->closeCursor();
            return $rows;
        } catch (\PDOException $e) {
            throw $this->db->driverError($e);
        }
    }

    /** A value of a boolean column as a bool: an integer 0 or 1 becomes false or true; any other value is INT-182. */
    private static function describedBoolean(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if ($value === 0 || $value === 1) {
            return $value === 1;
        }
        throw self::rule(Code::CATALOG_VALUE, self::RULE_BOOLEAN);
    }

    /** The width n of a MySQL BIT(n), as information_schema writes it. */
    private static function declaredWidth(string $nativeType): int
    {
        return preg_match('/^bit\((\d+)\)$/D', strtolower(trim($nativeType)), $m) === 1 ? (int) $m[1] : 0;
    }

    /**
     * The fraction digits p of a described MySQL or PostgreSQL time or datetime column: the digits that its native type
     * names, as in time(3) or timestamp(3) without time zone, and otherwise the default of the database, 0 on MySQL and
     * 6 on PostgreSQL. A precision above 6, or one that is not a number, is INT-181.
     */
    private static function declaredTemporalPrecision(string $dialect, string $nativeType): int
    {
        if (preg_match('/\(([^)]*)\)/', $nativeType, $m) !== 1) {
            return $dialect === 'postgres' ? 6 : 0;
        }
        if (preg_match('/^\d+$/D', $m[1]) !== 1 || (int) $m[1] > 6) {
            throw self::rule(Code::GRID_TEMPORAL_PRECISION, self::RULE_NATIVE_PRECISION);
        }
        return (int) $m[1];
    }

    /**
     * A MySQL or PostgreSQL temporal value of a described column, with exactly the p fraction digits of its column,
     * which drops the fraction when p is 0. A non-zero digit past p is INT-180.
     */
    private static function describedServerTemporal(string $text, string $kind, int $precision): string
    {
        if ($kind === 'date') {
            return self::serverDate($text);
        }
        $value = $kind === 'time' ? self::serverTime($text) : self::serverDateTime($text);
        $dot = strrpos($value, '.');
        if (trim(substr($value, $dot + 1 + $precision), '0') !== '') {
            throw self::rule(Code::GRID_TEMPORAL_PRECISION, self::RULE_FRACTION_PAST_PRECISION);
        }
        return $precision === 0 ? substr($value, 0, $dot) : substr($value, 0, $dot + 1 + $precision);
    }

    /**
     * The stored value of a described SQLite DATE, TIME or DATETIME column, which is returned as it is stored: its form
     * (INT-176 to INT-178) comes before its range (INT-173 to INT-175), and a time or a datetime has exactly the p
     * fraction digits that its dbspec CHECK fixes, 0 when it has none (INT-179).
     */
    private static function sqliteTemporal(mixed $value, string $kind, int $precision): string
    {
        $forms = [
            'date' => '/^(\d{4})-(\d{2})-(\d{2})$/D',
            'time' => '/^()()()(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/D',
            'datetime' => '/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/D',
        ];
        if (!is_string($value) || preg_match($forms[$kind], $value, $m) !== 1) {
            throw self::rule(Code::GRID_TEMPORAL_VALUE, self::RULE_SQLITE_FORM[$kind]);
        }
        if ($kind !== 'time') {
            self::calendarDate($m[1], $m[2], $m[3]);
        }
        if ($kind === 'date') {
            return $value;
        }
        if ((int) $m[4] > 23 || (int) $m[5] > 59 || (int) $m[6] > 59) {
            throw self::rule(Code::GRID_TEMPORAL_VALUE, self::RULE_TIME_RANGE);
        }
        if (strlen($m[7] ?? '') !== $precision) {
            throw self::rule(Code::GRID_TEMPORAL_PRECISION, self::RULE_SQLITE_FRACTION);
        }
        return $value;
    }

    /**
     * The temporal kind of a native type of a described MySQL or PostgreSQL column: date, time or datetime, by the
     * first word of the type. Every other type, and every SQLite type, has none.
     */
    private static function temporalKind(string $dialect, string $nativeType): ?string
    {
        $head = preg_split('/[( ]/', strtoupper($nativeType))[0];
        return match (true) {
            $dialect === 'sqlite' => null,
            $head === 'DATE' => 'date',
            $head === 'TIME' => 'time',
            $dialect === 'mysql' && $head === 'DATETIME',
            $dialect === 'postgres' && $head === 'TIMESTAMP' => 'datetime',
            default => null,
        };
    }

    /**
     * The fraction digits of a described temporal column: the digits that its native type names, as in time(3) or
     * timestamp(3) without time zone, and otherwise the default of the database, 0 on MySQL and 6 on PostgreSQL.
     */
    /**
     * The fraction digits that the CHECK of a SQLite column fixes, as Go reads them: a GLOB of n [0-9] classes is n
     * digits, and a whole-temporal IS time( or IS datetime( check is zero digits. Null when no CHECK names the column.
     */
    private static function checkPrecision(string $tableSql, string $column): ?int
    {
        $quoted = '"' . str_replace('"', '""', $column) . '"';
        foreach (self::checkClauses($tableSql) as $clause) {
            if (!str_contains($clause, $quoted)) {
                continue;
            }
            if (preg_match("/GLOB '((?:\\[0-9\\])*)'/", $clause, $glob) === 1) {
                return intdiv(strlen($glob[1]), strlen('[0-9]'));
            }
            if (preg_match('/IS (time|datetime)\(/', $clause) === 1) {
                return 0;
            }
        }
        return null;
    }

    /** The text inside each CHECK ( ... ) of a table definition, balanced over its parentheses. */
    private static function checkClauses(string $tableSql): array
    {
        $clauses = [];
        if (preg_match_all('/CHECK\s*\(/i', $tableSql, $matches, PREG_OFFSET_CAPTURE) === false) {
            return $clauses;
        }
        foreach ($matches[0] as [$opening, $offset]) {
            $start = $offset + strlen($opening);
            $depth = 1;
            $i = $start;
            while ($i < strlen($tableSql) && $depth > 0) {
                if ($tableSql[$i] === '(') {
                    $depth++;
                } elseif ($tableSql[$i] === ')') {
                    $depth--;
                }
                $i++;
            }
            if ($depth === 0) {
                $clauses[] = substr($tableSql, $start, $i - 1 - $start);
            }
        }
        return $clauses;
    }

    /**
     * A write of a temporal value with a non-zero digit beyond the declared precision of its column fails with
     * CODEC_ENCODE before any statement runs (docs/spec/errors.yaml). On SQLite the precision is the CHECK of the
     * column.
     */
    private static function checkWritePrecision(string $dialect, CatalogTableMetadata $metadata, array $values): void
    {
        if (array_is_list($values)) {
            // The list form names each value by its pair; a name that repeats is refused later, by changes().
            $map = [];
            foreach ($values as $pair) {
                if (is_array($pair) && count($pair) === 2 && is_string($pair[0] ?? null)) {
                    $map[$pair[0]] = $pair[1];
                }
            }
            $values = $map;
        }
        foreach ($metadata->columns as $column) {
            $value = $values[$column->name] ?? null;
            if (!is_string($value)) {
                continue;
            }
            $temporal = $dialect === 'sqlite'
                ? in_array(strtoupper($column->nativeType), ['TIME', 'DATETIME'], true)
                : self::temporalKind($dialect, $column->nativeType) !== null;
            if (!$temporal) {
                continue;
            }
            $dot = strpos($value, '.');
            if ($dot === false) {
                continue;
            }
            if ($dialect === 'sqlite') {
                // A SQLite column with no CHECK fixes no precision, so it has no write to refuse.
                if ($column->checkPrecision === null) {
                    continue;
                }
                $precision = $column->checkPrecision;
            } else {
                $precision = self::declaredPrecision($dialect, $column->nativeType);
            }
            $digits = substr($value, $dot + 1);
            if (strlen($digits) > $precision && trim(substr($digits, $precision), '0') !== '') {
                throw new OrmException(
                    Code::CODEC_ENCODE,
                    "temporal value has more fraction digits than its precision $precision"
                );
            }
        }
    }

    private static function declaredPrecision(string $dialect, string $nativeType): int
    {
        if (preg_match('/\((\d+)\)/', $nativeType, $match) === 1) {
            return (int) $match[1];
        }
        return $dialect === 'postgres' ? 6 : 0;
    }

    /**
     * A single-precision MySQL or PostgreSQL column holds float32: its value is the float32 nearest to the driver's
     * decimal. A SQLite REAL is a double, whatever its column declares (INT-183, INT-184).
     */
    private static function storedFloat(float $value, string $nativeType, string $dialect): float
    {
        return $dialect !== 'sqlite' && in_array(strtoupper($nativeType), ['REAL', 'FLOAT', 'FLOAT4'], true)
            ? unpack('g', pack('g', $value))[1]
            : $value;
    }

    /**
     * The plain conversion of a driver value: a host value that the conversion does not take for its column, or text
     * that is not an integer or a float of its integer or float column, is INT-171; SQLite keeps the storage class of a
     * value whatever its column declares (INT-184).
     */
    private static function value(mixed $value, string $nativeType, string $dialect): mixed
    {
        if (is_float($value)) {
            return self::storedFloat($value, $nativeType, $dialect);
        }
        if ($value === null || is_bool($value) || is_int($value)) {
            return $value;
        }
        if ($dialect === 'mysql' && strtoupper($nativeType) === 'YEAR') {
            return self::yearNumber($value);
        }
        if (is_resource($value)) {
            // PDO reads a PostgreSQL bytea as a stream (INT-107).
            return self::driverBytes($value);
        }
        if (!is_string($value)) {
            throw self::rule(Code::CATALOG_VALUE, self::RULE_DRIVER_VALUE);
        }
        // A value that is not valid UTF-8 is its bytes: a database tool shows the cell (INT-153).
        if (!self::isUtf8($value)) {
            return $value;
        }
        $class = self::typeClass($nativeType);
        if ($class === 'int' && $dialect === 'mysql') {
            $value = self::unpadded($value);
        }
        return match ($class) {
            // A BIGINT UNSIGNED reaches past PHP_INT_MAX as its digits; SQLite keeps a text in an INTEGER column.
            'int' => filter_var($value, FILTER_VALIDATE_INT) !== false ? (int) $value
                : ($dialect === 'sqlite' || self::isUnsignedDigits($value) ? $value
                    : throw self::rule(Code::CATALOG_VALUE, self::RULE_DRIVER_VALUE)),
            'float' => is_numeric($value) ? self::storedFloat((float) $value, $nativeType, $dialect)
                : ($dialect === 'sqlite' ? $value : throw self::rule(Code::CATALOG_VALUE, self::RULE_DRIVER_VALUE)),
            default => $value,
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
        throw new OrmException(Code::CATALOG_PARAM, 'parameter has an unsupported type');
    }

    /**
     * Checks named assignments against a descriptor and returns [column index, normalized value] in the order given.
     * Unknown, duplicate and generated columns, a NULL in a non-null column and unsupported values fail before any
     * statement runs.
     *
     * @param array<string, mixed> $values
     * @return list<array{0: int, 1: mixed}>
     */
    private static function changes(CatalogTableMetadata $metadata, array $values, string $code): array
    {
        // A key of defaults alone takes no assignment (INT-123).
        if (($values === [] && $code !== Code::ROW_INSERT_INVALID) || count($values) > count($metadata->columns)) {
            throw new OrmException($code, 'invalid column assignments');
        }
        // A list of [name, value] pairs may repeat a name (the form of Go, TypeScript and Python); a map has distinct
        // names.
        $normalized = [];
        if (array_is_list($values)) {
            foreach ($values as $pair) {
                if (!is_array($pair) || count($pair) !== 2 || !is_string($pair[0] ?? null)) {
                    throw new OrmException($code, 'an assignment is a [name, value] pair');
                }
                $normalized[] = [$pair[0], self::param($pair[1])];
            }
        } else {
            foreach ($values as $name => $value) {
                $normalized[] = [(string) $name, self::param($value)];
            }
        }
        $named = [];
        foreach ($normalized as [$name]) {
            if (isset($named[$name])) {
                throw new OrmException($code, 'duplicate column ' . Message::quote($name));
            }
            $named[$name] = true;
        }
        $changes = [];
        foreach ($normalized as [$name, $value]) {
            $index = self::indexOf($metadata, $name);
            if ($index < 0) {
                throw new OrmException($code, "unknown column " . Message::quote($name));
            }
            $column = $metadata->columns[$index];
            if ($column->generated) {
                throw new OrmException($code, "generated column " . Message::quote($name) . " is not writable");
            }
            if ($value === null && !$column->nullable) {
                throw new OrmException($code, "NULL in non-null column " . Message::quote($name));
            }
            if (is_string($value) && self::exceedsDeclaredCapacity($column, $value)) {
                throw new OrmException($code, "value exceeds the declared capacity of column " . Message::quote($name));
            }
            $changes[] = [$index, $value];
        }
        return $changes;
    }

    private static function exceedsDeclaredCapacity(CatalogColumn $column, string $value): bool
    {
        if (preg_match('/^(?:varchar|character varying)\\s*\\((\\d+)\\)/iD', $column->nativeType, $match) === 1) {
            return mb_strlen($value, 'UTF-8') > (int) $match[1];
        }
        if (preg_match('/^(?:varbinary|binary)\\s*\\((\\d+)\\)/iD', $column->nativeType, $match) === 1) {
            return strlen($value) > (int) $match[1];
        }
        return false;
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
        $invalid = static fn (string $reason, ?\Throwable $previous = null): OrmException
            => new OrmException(Code::ROW_SNAPSHOT_INVALID, "invalid original row or descriptor: $reason", $previous);
        if (!in_array($metadata->kind, ['table', 'partitioned'], true)) {
            throw $invalid('the relation is not a table');
        }
        if (
            !$metadata->reliableRowIdentity || $metadata->primaryKey === [] || $metadata->columns === []
            || count($metadata->columns) > 2048
        ) {
            throw $invalid('no reliable row identity');
        }
        $names = [];
        foreach ($metadata->columns as $column) {
            try {
                self::checkName($column->name);
            } catch (OrmException $e) {
                throw $invalid($e->getMessage(), $e);
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
            throw new OrmException(
                Code::ROW_SNAPSHOT_INVALID,
                'row has ' . count($cells) . ' cells for ' . count($metadata->columns) . ' columns'
            );
        }
        foreach ($cells as $i => $cell) {
            if ($cell === null && !$metadata->columns[$i]->nullable) {
                throw new OrmException(
                    Code::ROW_SNAPSHOT_INVALID,
                    'NULL in non-null column "' . $metadata->columns[$i]->name . '"'
                );
            }
            self::cellKey($cell);
        }
    }

    /**
     * The canonical text of one cell: its type and its exact value. Two cells are equal exactly when their keys are
     * equal, so a float compares by its bits.
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
            // The bytes of a binary cell are hex: the revision encodes its descriptor and cells as JSON text (INT-107).
            return self::isUtf8($cell) ? 's' . strlen($cell) . ':' . $cell : 'x' . bin2hex($cell);
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

    /**
     * Reads the rows that match the primary key of a descriptor, at most two. A lock takes FOR UPDATE where the server
     * supports it.
     */
    private function lookup(\PDO $pdo, CatalogTableMetadata $metadata, array $keys, bool $lock): array
    {
        $suffix = $lock && $this->dialect !== 'sqlite' ? ' FOR UPDATE' : '';
        $sql = 'SELECT ' . self::quoteList(self::columnNames($metadata), $this->dialect)
            . ' FROM ' . self::qualified($metadata->table, $this->dialect)
            . ' WHERE ' . $this->keyPredicate($metadata) . ' LIMIT 2' . $suffix;
        $raw = $this->query($pdo, $sql, $keys, 2, self::PAGE_BYTES, cells: true);
        self::sameNames($raw['names'], $metadata, Code::TABLE_PAGE_METADATA_CHANGED);
        return $this->describedRows($pdo, $raw, $metadata);
    }

    /**
     * Refuses a MySQL row change on a server with partial revokes, before the change locks anything: such a server may
     * hide a trigger from the account (INT-119). The statement lists the setting when it is not OFF; MariaDB has no
     * partial revokes and lists no row, the one form that both servers answer with the same result (DIA-207).
     */
    private function mysqlPartialRevokesOff(\PDO $pdo): void
    {
        $partial = $this->query(
            $pdo,
            "SHOW GLOBAL VARIABLES WHERE Variable_name = 'partial_revokes' AND Value <> 'OFF'",
            [],
            1,
            4096
        );
        if (count($partial['rows']) !== 0) {
            throw new OrmException(
                Code::ROW_MUTATION_UNSUPPORTED,
                'MySQL partial-revoke visibility requires verification'
            );
        }
    }

    /**
     * Refuses a MySQL row change unless the account and the table are verified: the account holds TRIGGER on the table,
     * the table is InnoDB and it has no triggers (mutation.rs, mysql_safety).
     */
    private function mysqlSafety(\PDO $pdo, CatalogTableMetadata $metadata): void
    {
        $account = $this->query($pdo, 'SELECT CURRENT_USER()', [], 1, 4096);
        $text = $account['rows'][0][0] ?? null;
        $at = is_string($text) ? strrpos($text, '@') : false;
        if (count($account['rows']) !== 1 || !is_string($text) || $at === false) {
            throw new OrmException(Code::ROW_MUTATION_UNSUPPORTED, 'unverifiable MySQL account');
        }
        $grantee = "'" . substr($text, 0, $at) . "'@'" . substr($text, $at + 1) . "'";

        $ns = $metadata->table['namespace'];
        $grants = $this->query(
            $pdo,
            "SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=? AND "
            . "PRIVILEGE_TYPE='TRIGGER' "
            . "UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=? AND "
            . "TABLE_SCHEMA=? AND PRIVILEGE_TYPE='TRIGGER' "
            . "UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=? AND "
            . "TABLE_SCHEMA=? AND TABLE_NAME=? AND PRIVILEGE_TYPE='TRIGGER'",
            [$grantee, $grantee, $ns, $grantee, $ns, $metadata->table['name']],
            16,
            4096
        );
        $trigger = false;
        foreach ($grants['rows'] as $row) {
            if (count($row) === 1 && $row[0] === 'TRIGGER') {
                $trigger = true;
            }
        }
        if (!$trigger) {
            throw new OrmException(Code::ROW_MUTATION_UNSUPPORTED, 'MySQL trigger visibility is unverified');
        }

        $engine = $this->query(
            $pdo,
            'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
            [$ns, $metadata->table['name']],
            2,
            4096
        );
        if (count($engine['rows']) !== 1 || count($engine['rows'][0]) !== 1) {
            throw new OrmException(Code::ROW_MUTATION_UNSUPPORTED, 'MySQL requires InnoDB');
        }
        $name = $engine['rows'][0][0];
        if (!is_string($name) || strcasecmp($name, 'InnoDB') !== 0) {
            throw new OrmException(Code::ROW_MUTATION_UNSUPPORTED, 'MySQL requires InnoDB');
        }

        $triggers = $this->query(
            $pdo,
            'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND '
            . 'EVENT_OBJECT_TABLE=? LIMIT 1',
            [$ns, $metadata->table['name']],
            1,
            4096
        );
        if ($triggers['rows'] !== []) {
            throw new OrmException(Code::ROW_MUTATION_UNSUPPORTED, 'MySQL triggers require effect verification');
        }
    }

    /**
     * Refuses a read query that is not one supported non-locking read query: it tokenizes the query, so keywords inside
     * string literals, quoted identifiers and comments are not seen, and refuses a MySQL executable comment.
     */
    private static function validateReadOnly(string $query, string $dialect): void
    {
        $refused = static fn (): OrmException => new OrmException(
            Code::QUERY_READ_ONLY,
            'expected one supported non-locking read query'
        );
        if ($query === '') {
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
     * The upper-cased words of a query and its semicolons. String literals, quoted identifiers and comments are
     * skipped. It returns null for an unterminated literal or comment and for a MySQL executable comment.
     *
     * @return list<string>|null
     */
    private static function words(string $query, string $dialect, ?int &$semicolon = null): ?array
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
                // MySQL reads backslash escapes inside string literals and double-quoted strings; other dialects do
                // not.
                $next = self::skipQuoted($query, $i, $c, $dialect === 'mysql' && $c !== '`');
                if ($next === null) {
                    return null;
                }
                $i = $next;
            } elseif ($c === '_' || self::isLetter($c)) {
                $j = $i;
                while (
                    $j < $n && (
                    $query[$j] === '_' || $query[$j] === '$' || self::isLetter($query[$j]) || self::isDigit($query[$j])
                    )
                ) {
                    $j++;
                }
                $words[] = strtoupper(substr($query, $i, $j - $i));
                $i = $j;
            } elseif (self::isDigit($c)) {
                $j = $i;
                while (
                    $j < $n && (
                    $query[$j] === '.' || $query[$j] === '_' || self::isLetter($query[$j]) || self::isDigit($query[$j])
                    )
                ) {
                    $j++;
                }
                $i = $j;
            } else {
                if ($c === ';') {
                    $words[] = ';';
                    $semicolon = $i;
                }
                $i++;
            }
        }
        return $words;
    }

    /**
     * The index after the literal or identifier that starts at start, with the doubled quote mark and, when backslash
     * is set, backslash escapes.
     */
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
