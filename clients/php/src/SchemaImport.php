<?php
declare(strict_types=1);

namespace Orm;

/**
 * Reads the schema of a live database and writes it as a Mermaid diagram
 * (docs/schema.md §6); the live manifest used by validate and migrate is the
 * build of that diagram.
 *
 * A table is ['name', 'comment', 'columns', 'indexes', 'foreign_keys',
 * 'checks']; a column default of null means no default.
 */
final class SchemaImport
{
    /**
     * Opens the database named by a DSN URI (mysql://, postgres://, or
     * sqlite://<absolute path>) and returns [dialect, pdo]. The scheme selects
     * the dialect.
     */
    public static function connect(string $raw): array
    {
        $u = self::uri($raw);
        $dialect = $u['scheme'];
        switch ($dialect) {
            case 'mysql':
            case 'postgres':
                $database = trim($u['path'], '/');
                $missingHost = $dialect === 'mysql' ? $u['host'] === '' : $u['host'] === '' && ($u['query']['host'] ?? '') === '';
                if ($missingHost || $database === '') {
                    throw new \RuntimeException("MIGRATION_CONFIG: $dialect DSN must include host and database");
                }
                break;
            case 'sqlite':
                if (!str_starts_with($u['path'], '/') || $u['host'] !== '') {
                    throw new \RuntimeException('MIGRATION_CONFIG: sqlite DSN must be sqlite://<absolute path>');
                }
                break;
            default:
                throw new \RuntimeException('MIGRATION_CONFIG: unsupported DSN scheme ' . Go::quote($u['rawScheme']) . '; want mysql, postgres, or sqlite');
        }
        try {
            if ($dialect === 'sqlite') {
                $pdo = new \PDO('sqlite:' . $u['path'], null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
            } else {
                [, $pdoDsn, $user, $password] = Orm::parseDsn($raw);
                $pdo = new \PDO($pdoDsn, $user, $password, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION, \PDO::ATTR_EMULATE_PREPARES => false]);
                $zone = $u['query']['timezone'] ?? '';
                if ($dialect === 'mysql' && $zone !== '') {
                    $pdo->exec("SET time_zone = '" . str_replace("'", "''", $zone) . "'");
                }
            }
            $pdo->query('SELECT 1');
        } catch (\PDOException|OrmException $e) {
            throw new \RuntimeException('MIGRATION_CONNECT: dsn=' . self::redact($raw) . ': ' . $e->getMessage());
        }
        return [$dialect, $pdo];
    }

    /** The dialect a DSN URI names, after the same checks as connect. */
    public static function dialect(string $raw): string
    {
        $scheme = self::uri($raw)['scheme'];
        if (!in_array($scheme, ['mysql', 'postgres', 'sqlite'], true)) {
            throw new \RuntimeException('MIGRATION_CONFIG: unsupported DSN scheme ' . Go::quote(self::uri($raw)['rawScheme']) . '; want mysql, postgres, or sqlite');
        }
        return $scheme;
    }

    /**
     * Splits a URI into scheme, user, password, host, path, and query.
     * @return array{scheme: string, rawScheme: string, user: ?string, password: ?string, host: string, path: string, query: array<string, string>, authority: string, rest: string}
     */
    private static function uri(string $raw): array
    {
        if (preg_match('~^([A-Za-z][A-Za-z0-9+.-]*):(?://([^/?#]*))?([^?#]*)(?:\?([^#]*))?~', $raw, $m) !== 1) {
            throw new \RuntimeException('MIGRATION_CONFIG: dsn must be a URI using mysql://, postgres://, or sqlite://');
        }
        $authority = $m[2] ?? '';
        $user = $password = null;
        $host = $authority;
        $at = strrpos($authority, '@');
        if ($at !== false) {
            $info = substr($authority, 0, $at);
            $host = substr($authority, $at + 1);
            $colon = strpos($info, ':');
            $user = rawurldecode($colon === false ? $info : substr($info, 0, $colon));
            $password = $colon === false ? null : rawurldecode(substr($info, $colon + 1));
        }
        $query = [];
        foreach (explode('&', $m[4] ?? '') as $pair) {
            if ($pair === '') {
                continue;
            }
            [$k, $v] = array_pad(explode('=', $pair, 2), 2, '');
            $k = urldecode($k);
            $query[$k] ??= urldecode($v);
        }
        return ['scheme' => strtolower($m[1]), 'rawScheme' => $m[1], 'user' => $user, 'password' => $password, 'host' => $host,
            'path' => rawurldecode($m[3]), 'query' => $query, 'authority' => $authority, 'rest' => substr($raw, strlen($m[1]) + 3 + strlen($authority))];
    }

    /** A DSN URI with its password replaced, as Go's url.URL.Redacted. */
    public static function redact(string $raw): string
    {
        try {
            $u = self::uri($raw);
        } catch (\RuntimeException) {
            return 'dsn://';
        }
        if ($u['password'] === null) {
            return $raw;
        }
        $at = strrpos($u['authority'], '@');
        $info = substr($u['authority'], 0, $at);
        $user = substr($info, 0, (int) strpos($info, ':'));
        return $u['rawScheme'] . '://' . $user . ':xxxxx@' . substr($u['authority'], $at + 1) . $u['rest'];
    }

    /** @param array<string, true>|null $only */
    public static function readTables(\PDO $db, string $driver, ?array $only = null): array
    {
        return match ($driver) {
            'postgres' => self::readPostgres($db, $only),
            'sqlite' => array_values(array_filter(self::readSqlite($db), static fn(array $t): bool => $only === null || isset($only[$t['name']]))),
            default => self::readMysql($db, $only),
        };
    }

    /** @param array<string, true>|null $only */
    private static function readMysql(\PDO $db, ?array $only): array
    {
        $byName = [];
        $rows = $db->query('SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_KEY, COLUMN_COMMENT
		FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION');
        foreach ($rows->fetchAll(\PDO::FETCH_NUM) as [$table, $name, $type, $nullable, $default, $extra, $key, $comment]) {
            if ($only !== null && !isset($only[$table])) {
                continue;
            }
            $byName[$table] ??= self::table($table);
            $extra = (string) $extra;
            if ($default !== null && str_contains($extra, 'DEFAULT_GENERATED')) {
                $literal = self::mysqlExpressionLiteral((string) $default);
                if ($literal !== null) {
                    $default = $literal;
                    $extra = SchemaParser::trim(preg_replace('/DEFAULT_GENERATED/', '', $extra, 1));
                }
            }
            $byName[$table]['columns'][] = ['name' => $name, 'type' => $type, 'nullable' => $nullable === 'YES', 'default' => $default,
                'extra' => $extra, 'key' => (string) $key, 'comment' => (string) $comment];
        }
        foreach ($db->query('SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()')->fetchAll(\PDO::FETCH_NUM) as [$name, $comment]) {
            if (isset($byName[$name])) {
                $byName[$name]['comment'] = (string) $comment;
            }
        }
        $rows = $db->query('SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, INDEX_TYPE, COLUMN_NAME FROM information_schema.STATISTICS
		WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX');
        foreach ($rows->fetchAll(\PDO::FETCH_NUM) as [$table, $name, $nonUnique, $type, $col]) {
            if (!isset($byName[$table]) || $name === 'PRIMARY') {
                continue;
            }
            self::addIndexColumn($byName[$table], $name, (int) $nonUnique === 0, $type === 'FULLTEXT', $col);
        }
        $rows = $db->query('SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME,
		k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE
		FROM information_schema.KEY_COLUMN_USAGE k
		JOIN information_schema.REFERENTIAL_CONSTRAINTS r
		  ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
		WHERE k.TABLE_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
		ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION');
        foreach ($rows->fetchAll(\PDO::FETCH_NUM) as [$table, $name, $column, $target, $targetColumn, $action]) {
            if (isset($byName[$table])) {
                self::addForeignKeyColumn($byName[$table], $name, $target, self::deleteAction($action), $column, $targetColumn);
            }
        }
        $rows = $db->query("SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
		FROM information_schema.TABLE_CONSTRAINTS tc
		JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
		WHERE tc.CONSTRAINT_SCHEMA=DATABASE() AND tc.CONSTRAINT_TYPE='CHECK'
		ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME");
        foreach ($rows->fetchAll(\PDO::FETCH_NUM) as [$table, $name, $expr]) {
            if (isset($byName[$table])) {
                // DDL writes the physical name ck_<table>_<name>; import returns the declared name.
                $prefix = 'ck_' . $table . '_';
                $byName[$table]['checks'][] = ['name' => str_starts_with($name, $prefix) ? substr($name, strlen($prefix)) : $name, 'expr' => $expr];
            }
        }
        return self::sorted($byName);
    }

    /**
     * The literal of an expression default such as DEFAULT ('x'), which MySQL
     * reports as _utf8mb4\\'x\\'; the expression text escapes the literal.
     */
    private static function mysqlExpressionLiteral(string $def): ?string
    {
        if (preg_match("/^_[A-Za-z0-9]+\\\\'(.*)\\\\'$/D", $def, $m) === 1) {
            return self::mysqlUnescape(self::mysqlUnescape($m[1]));
        }
        return SchemaDdl::isNumber($def) ? $def : null;
    }

    private static function mysqlUnescape(string $s): string
    {
        $out = '';
        $n = strlen($s);
        for ($i = 0; $i < $n; $i++) {
            if ($s[$i] === '\\' && $i + 1 < $n) {
                $i++;
            }
            $out .= $s[$i];
        }
        return $out;
    }

    private static function table(string $name): array
    {
        return ['name' => $name, 'comment' => '', 'columns' => [], 'indexes' => [], 'foreign_keys' => [], 'checks' => []];
    }

    private static function sorted(array $byName): array
    {
        return array_map(static fn(string $n): array => $byName[$n], SchemaDdl::sortedKeys($byName));
    }

    private static function addIndexColumn(array &$t, string $name, bool $unique, bool $fulltext, string $col): void
    {
        $n = count($t['indexes']);
        if ($n > 0 && $t['indexes'][$n - 1]['name'] === $name) {
            $t['indexes'][$n - 1]['columns'][] = $col;
            return;
        }
        $t['indexes'][] = ['name' => $name, 'unique' => $unique, 'fulltext' => $fulltext, 'columns' => [$col]];
    }

    private static function addForeignKeyColumn(array &$t, string $name, string $target, string $onDelete, string $column, string $targetColumn): void
    {
        $n = count($t['foreign_keys']);
        if ($n === 0 || $t['foreign_keys'][$n - 1]['name'] !== $name) {
            $t['foreign_keys'][] = ['name' => $name, 'columns' => [], 'target' => $target, 'target_columns' => [], 'on_delete' => $onDelete];
            $n++;
        }
        $t['foreign_keys'][$n - 1]['columns'][] = $column;
        $t['foreign_keys'][$n - 1]['target_columns'][] = $targetColumn;
    }

    public static function deleteAction(string $action): string
    {
        return match (strtoupper(str_replace('_', ' ', $action))) {
            'CASCADE' => 'cascade',
            'SET NULL' => 'setnull',
            default => '',
        };
    }

    private static function bool(mixed $v): bool
    {
        return $v === true || $v === 't' || $v === 1 || $v === '1' || $v === 'true';
    }

    /** @param array<string, true>|null $only */
    private static function readPostgres(\PDO $db, ?array $only): array
    {
        $byName = [];
        $rows = $db->query("SELECT c.table_name, c.column_name, c.data_type, c.character_maximum_length,
		       c.numeric_precision, c.numeric_scale, c.datetime_precision, c.udt_name,
		       c.is_nullable, c.column_default, c.is_identity, coalesce(d.description, '')
		  FROM information_schema.columns c
		  JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
		  LEFT JOIN pg_catalog.pg_class cl ON cl.relname = c.table_name
		  LEFT JOIN pg_catalog.pg_description d ON d.objoid = cl.oid AND d.objsubid = c.ordinal_position
		 WHERE c.table_schema = current_schema()
		 ORDER BY c.table_name, c.ordinal_position");
        foreach ($rows->fetchAll(\PDO::FETCH_NUM) as [$table, $name, $dataType, $charLen, $numPrec, $numScale, $dtPrec, $udt, $nullable, $default, $identity, $comment]) {
            if ($only !== null && !isset($only[$table])) {
                continue;
            }
            $c = ['name' => $name, 'type' => self::pgType($dataType, (string) $udt, $charLen, $numPrec, $numScale, $dtPrec), 'nullable' => $nullable === 'YES',
                'default' => null, 'extra' => '', 'key' => '', 'comment' => (string) $comment];
            if ($identity === 'YES' || ($default !== null && str_starts_with($default, 'nextval('))) {
                $c['extra'] = 'auto_increment';
            } elseif ($default !== null) {
                $c['default'] = self::pgDefault($default);
            }
            $byName[$table] ??= self::table($table);
            $byName[$table]['columns'][] = $c;
        }
        $rows = $db->query("SELECT c.relname, coalesce(d.description, '')
		FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace AND n.nspname=current_schema()
		LEFT JOIN pg_catalog.pg_description d ON d.objoid=c.oid AND d.objsubid=0
		WHERE c.relkind='r'");
        foreach ($rows->fetchAll(\PDO::FETCH_NUM) as [$name, $comment]) {
            if (isset($byName[$name])) {
                $byName[$name]['comment'] = (string) $comment;
            }
        }
        $rows = $db->query('SELECT cl.relname AS table_name, ic.relname AS index_name, ix.indisunique, ix.indisprimary,
		       am.amname, a.attname, k.ord
		  FROM pg_class cl
		  JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = current_schema()
		  JOIN pg_index ix ON ix.indrelid = cl.oid
		  JOIN pg_class ic ON ic.oid = ix.indexrelid
		  JOIN pg_am am ON am.oid = ic.relam
		  JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
		  JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = k.attnum
		 ORDER BY cl.relname, ic.relname, k.ord');
        foreach ($rows->fetchAll(\PDO::FETCH_NUM) as [$table, $name, $unique, $primary, $am, $col]) {
            if (!isset($byName[$table])) {
                continue;
            }
            if (self::bool($primary)) {
                foreach ($byName[$table]['columns'] as $i => $c) {
                    if ($c['name'] === $col) {
                        $byName[$table]['columns'][$i]['key'] = 'PRI';
                    }
                }
                continue;
            }
            $unique = self::bool($unique);
            $logical = $unique ? $name : (str_starts_with($name, $table . '_') ? substr($name, strlen($table) + 1) : $name);
            self::addIndexColumn($byName[$table], $logical, $unique, $am === 'gin', $col);
        }
        $rows = $db->query("SELECT child.relname, con.conname, ca.attname, parent.relname, pa.attname, con.confdeltype, ck.ord
		FROM pg_constraint con
		JOIN pg_class child ON child.oid=con.conrelid
		JOIN pg_namespace n ON n.oid=child.relnamespace AND n.nspname=current_schema()
		JOIN pg_class parent ON parent.oid=con.confrelid
		JOIN LATERAL unnest(con.conkey) WITH ORDINALITY ck(attnum, ord) ON true
		JOIN LATERAL unnest(con.confkey) WITH ORDINALITY pk(attnum, ord) ON pk.ord=ck.ord
		JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=ck.attnum
		JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=pk.attnum
		WHERE con.contype='f'
		ORDER BY child.relname, con.conname, ck.ord");
        foreach ($rows->fetchAll(\PDO::FETCH_NUM) as [$table, $name, $column, $target, $targetColumn, $action]) {
            if (isset($byName[$table])) {
                $onDelete = match ((string) $action) { 'c' => 'cascade', 'n' => 'setnull', default => '' };
                self::addForeignKeyColumn($byName[$table], $name, $target, $onDelete, $column, $targetColumn);
            }
        }
        $rows = $db->query("SELECT child.relname, con.conname, pg_get_constraintdef(con.oid)
		FROM pg_constraint con
		JOIN pg_class child ON child.oid=con.conrelid
		JOIN pg_namespace n ON n.oid=child.relnamespace AND n.nspname=current_schema()
		WHERE con.contype='c' ORDER BY child.relname, con.conname");
        foreach ($rows->fetchAll(\PDO::FETCH_NUM) as [$table, $name, $definition]) {
            if (isset($byName[$table])) {
                $byName[$table]['checks'][] = ['name' => $name, 'expr' => self::postgresCheckExpr($definition)];
            }
        }
        $rows = $db->query("SELECT cl.relname, ic.relname, pg_get_indexdef(ic.oid)
		FROM pg_class cl
		JOIN pg_namespace n ON n.oid=cl.relnamespace AND n.nspname=current_schema()
		JOIN pg_index ix ON ix.indrelid=cl.oid
		JOIN pg_class ic ON ic.oid=ix.indexrelid
		JOIN pg_am am ON am.oid=ic.relam
		WHERE am.amname='gin'
		ORDER BY cl.relname, ic.relname");
        foreach ($rows->fetchAll(\PDO::FETCH_NUM) as [$table, $name, $definition]) {
            if (!isset($byName[$table])) {
                continue;
            }
            try {
                $columns = self::postgresFulltextColumns($definition);
            } catch (\RuntimeException $e) {
                throw new \RuntimeException("table $table index $name: " . $e->getMessage());
            }
            $byName[$table]['indexes'][] = ['name' => $name, 'unique' => false, 'fulltext' => true, 'columns' => $columns];
        }
        return self::sorted($byName);
    }

    /** @return list<string> the columns of a generated full-text index definition */
    public static function postgresFulltextColumns(string $definition): array
    {
        if (!str_contains(strtolower($definition), 'to_tsvector')) {
            throw new \RuntimeException('unsupported PostgreSQL GIN expression: ' . $definition);
        }
        preg_match_all('/coalesce\s*\(\s*\(?\s*"?([a-z_][a-z0-9_]*)"?\s*,/i', $definition, $matches);
        $columns = array_values(array_unique($matches[1]));
        if ($columns === []) {
            throw new \RuntimeException('unsupported PostgreSQL GIN expression: ' . $definition);
        }
        return $columns;
    }

    private static function pgType(string $dataType, string $udt, mixed $charLen, mixed $numPrec, mixed $numScale, mixed $dtPrec): string
    {
        return match ($dataType) {
            'character varying', 'character' => $charLen !== null ? sprintf('varchar(%d)', $charLen) : 'text',
            'integer' => 'int',
            'smallint' => 'smallint',
            'bigint' => 'bigint',
            'boolean' => 'tinyint',
            'double precision', 'real' => 'double',
            'numeric' => $numPrec !== null ? sprintf('decimal(%d,%d)', $numPrec, (int) $numScale) : 'decimal',
            'timestamp without time zone', 'timestamp with time zone' => $dtPrec !== null && (int) $dtPrec > 0 ? sprintf('datetime(%d)', $dtPrec) : 'datetime',
            'date' => 'date',
            'time without time zone', 'time with time zone' => 'time',
            'bytea' => 'blob',
            'json', 'jsonb' => 'jsontext',
            'inet' => 'varbinary(16)',
            'text' => 'text',
            default => $udt,
        };
    }

    private static function pgDefault(string $d): string
    {
        $i = strpos($d, '::');
        if ($i !== false && $i > 0) {
            $d = substr($d, 0, $i);
        }
        $d = trim($d, "'");
        return match (strtolower($d)) {
            'now()', 'current_timestamp' => 'CURRENT_TIMESTAMP',
            'true' => '1',
            'false' => '0',
            default => $d,
        };
    }

    private static function readSqlite(\PDO $db): array
    {
        $out = [];
        $tables = $db->query("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'orm_schema_migrations' AND name <> 'orm_schema_comments' AND name <> 'orm__context' ORDER BY name");
        foreach ($tables->fetchAll(\PDO::FETCH_NUM) as [$name, $createSql]) {
            $t = self::table($name);
            $t['checks'] = self::sqliteChecks($name, (string) $createSql);
            $qname = str_replace("'", "''", $name);
            foreach ($db->query("PRAGMA table_info('$qname')")->fetchAll(\PDO::FETCH_NUM) as [, $cname, $type, $notnull, $default, $pk]) {
                if ($default !== null && self::sqliteClockDefault((string) $default)) {
                    $default = 'CURRENT_TIMESTAMP';
                }
                $t['columns'][] = ['name' => $cname, 'type' => $type, 'nullable' => (int) $notnull === 0 && (int) $pk === 0, 'default' => $default,
                    'extra' => (int) $pk > 0 && self::sqliteAutoIncrement((string) $createSql, $cname) ? 'auto_increment' : '',
                    'key' => (int) $pk > 0 ? 'PRI' : '', 'comment' => ''];
            }
            foreach ($db->query("PRAGMA index_list('$qname')")->fetchAll(\PDO::FETCH_NUM) as [, $indexName, $unique, $origin]) {
                if ($origin === 'pk') {
                    continue;
                }
                $logical = (int) $unique === 0 && str_starts_with($indexName, $name . '_') ? substr($indexName, strlen($name) + 1) : $indexName;
                $ix = ['name' => $logical, 'unique' => (int) $unique !== 0, 'fulltext' => false, 'columns' => []];
                foreach ($db->query("PRAGMA index_info('" . str_replace("'", "''", $indexName) . "')")->fetchAll(\PDO::FETCH_NUM) as [, , $col]) {
                    $ix['columns'][] = (string) $col;
                }
                if ($ix['columns'] !== []) {
                    $t['indexes'][] = $ix;
                }
            }
            $byId = [];
            foreach ($db->query("PRAGMA foreign_key_list('$qname')")->fetchAll(\PDO::FETCH_NUM) as [$id, , $target, $column, $targetColumn, , $onDelete]) {
                if (!isset($byId[$id])) {
                    $byId[$id] = count($t['foreign_keys']);
                    $t['foreign_keys'][] = ['name' => "fk_{$name}_$id", 'columns' => [], 'target' => $target, 'target_columns' => [], 'on_delete' => self::deleteAction((string) $onDelete)];
                }
                $t['foreign_keys'][$byId[$id]]['columns'][] = $column;
                $t['foreign_keys'][$byId[$id]]['target_columns'][] = (string) $targetColumn;
            }
            $out[] = $t;
        }
        try {
            $comments = $db->query('SELECT table_name, column_name, comment FROM orm_schema_comments')->fetchAll(\PDO::FETCH_NUM);
        } catch (\PDOException $e) {
            if (!str_contains(strtolower($e->getMessage()), 'no such table')) {
                throw new \RuntimeException('sqlite schema comments: ' . $e->getMessage());
            }
            $comments = [];
        }
        foreach ($comments as [$table, $column, $comment]) {
            foreach ($out as $i => $t) {
                if ($t['name'] !== $table) {
                    continue;
                }
                if ($column === '') {
                    $out[$i]['comment'] = $comment;
                } else {
                    foreach ($t['columns'] as $j => $c) {
                        if ($c['name'] === $column) {
                            $out[$i]['columns'][$j]['comment'] = $comment;
                        }
                    }
                }
            }
        }
        return $out;
    }

    /** Reports the column default the DDL writes for =now. */
    private static function sqliteClockDefault(string $def): bool
    {
        $def = SchemaParser::trim($def);
        while (strlen($def) > 1 && $def[0] === '(' && $def[strlen($def) - 1] === ')') {
            $def = SchemaParser::trim(substr($def, 1, -1));
        }
        return strcasecmp($def, 'CURRENT_TIMESTAMP') === 0 || $def === "strftime('%Y-%m-%d %H:%M:%f', 'now') || '000'";
    }

    /** Reports whether a CREATE TABLE text declares a column as INTEGER PRIMARY KEY AUTOINCREMENT. */
    private static function sqliteAutoIncrement(string $createSql, string $column): bool
    {
        $fields = preg_split('/[ \t\n\v\f\r]+/', strtoupper($createSql), -1, PREG_SPLIT_NO_EMPTY) ?: [];
        $upper = strtoupper($column);
        $names = ['"' . $upper . '"' => true, '`' . $upper . '`' => true, $upper => true, '[' . $upper . ']' => true];
        for ($i = 0; $i + 4 < count($fields); $i++) {
            $name = ltrim($fields[$i], '(,');
            if (isset($names[$name]) && $fields[$i + 1] === 'INTEGER' && $fields[$i + 2] === 'PRIMARY' && $fields[$i + 3] === 'KEY' && rtrim($fields[$i + 4], ',)') === 'AUTOINCREMENT') {
                return true;
            }
        }
        return false;
    }

    /** Strips the CHECK keyword from pg_get_constraintdef. */
    public static function postgresCheckExpr(string $definition): string
    {
        $expr = SchemaParser::trim($definition);
        if (strlen($expr) >= 5 && strcasecmp(substr($expr, 0, 5), 'CHECK') === 0) {
            $expr = SchemaParser::trim(substr($expr, 5));
        }
        return $expr;
    }

    /** @return list<array{name: string, expr: string}> the CHECK constraints of a CREATE TABLE statement */
    public static function sqliteChecks(string $table, string $sql): array
    {
        $checks = [];
        $n = strlen($sql);
        for ($i = 0; $i < $n; $i++) {
            $c = $sql[$i];
            if ($c === "'" || $c === '"' || $c === '`') {
                for ($i++; $i < $n; $i++) {
                    if ($sql[$i] === $c) {
                        if ($i + 1 < $n && $sql[$i + 1] === $c) {
                            $i++;
                            continue;
                        }
                        break;
                    }
                }
                continue;
            }
            if ($i + 5 > $n || strcasecmp(substr($sql, $i, 5), 'CHECK') !== 0 || ($i > 0 && self::identByte($sql[$i - 1])) || ($i + 5 < $n && self::identByte($sql[$i + 5]))) {
                continue;
            }
            $j = $i + 5;
            while ($j < $n && str_contains(" \t\r\n", $sql[$j])) {
                $j++;
            }
            if ($j >= $n || $sql[$j] !== '(') {
                throw new \RuntimeException("table $table: sqlite CHECK expression missing opening parenthesis");
            }
            try {
                $end = self::balancedParen($sql, $j);
            } catch (\RuntimeException $e) {
                throw new \RuntimeException("table $table: sqlite CHECK expression: " . $e->getMessage());
            }
            $name = sprintf('check_%s_%d', $table, count($checks) + 1);
            $prefix = SchemaParser::trim(substr($sql, 0, $i));
            $k = strrpos(strtoupper($prefix), 'CONSTRAINT ');
            if ($k !== false) {
                $candidate = SchemaParser::trim(substr($prefix, $k + strlen('CONSTRAINT ')));
                if ($candidate !== '' && strpbrk($candidate, " ,()\t\r\n") === false) {
                    $name = trim($candidate, '`"');
                }
            }
            $checks[] = ['name' => $name, 'expr' => SchemaParser::trim(substr($sql, $j + 1, $end - $j - 1))];
            $i = $end;
        }
        return $checks;
    }

    private static function identByte(string $b): bool
    {
        return $b === '_' || ctype_alnum($b);
    }

    public static function balancedParen(string $s, int $start): int
    {
        $depth = 0;
        $n = strlen($s);
        for ($i = $start; $i < $n; $i++) {
            $c = $s[$i];
            if ($c === "'" || $c === '"' || $c === '`') {
                for ($i++; $i < $n && $s[$i] !== $c; $i++) {
                }
                if ($i >= $n) {
                    throw new \RuntimeException('unterminated quoted value');
                }
            } elseif ($c === '(') {
                $depth++;
            } elseif ($c === ')') {
                $depth--;
                if ($depth === 0) {
                    return $i;
                }
            }
        }
        throw new \RuntimeException('unbalanced parentheses');
    }

    /** Infers the parent table of a `<role>_<table>_seq` column. */
    private static function fkTarget(string $col, array $tables): string
    {
        if (!str_ends_with($col, '_seq')) {
            return '';
        }
        $parts = explode('_', substr($col, 0, -4));
        for ($i = 0; $i < count($parts); $i++) {
            $t = implode('_', array_slice($parts, $i));
            if (isset($tables[$t])) {
                return $t;
            }
        }
        return '';
    }

    /** @return array{string, bool} the diagram spelling of a column type and whether it is unsigned */
    /**
     * Names a text column that carries the json codec as jsontext, the type
     * the ORM declares for the ordered-json text.
     */
    public static function importedJsonText(string $name, string $type): string
    {
        if ($type === 'jsontext' || (!str_starts_with($name, 'json_') && !str_starts_with($name, 'jsons_'))) {
            return $type;
        }
        return in_array($type, ['text', 'longtext', 'mediumtext', 'tinytext'], true) ? 'jsontext' : $type;
    }

    public static function mermaidType(string $t): array
    {
        $t = strtolower($t);
        $unsigned = str_ends_with($t, ' unsigned');
        if ($unsigned) {
            $t = substr($t, 0, -strlen(' unsigned'));
        }
        $i = strpos($t, '(');
        if ($i !== false && str_ends_with($t, ')')) {
            $inner = str_replace([ "'", ','], ['', '_'], substr($t, $i + 1, -1));
            $t = substr($t, 0, $i) . '(' . $inner . ')';
        }
        return [$t, $unsigned];
    }

    /** The Mermaid diagram of live tables, keeping the facts of a previous diagram. */
    public static function renderMermaid(array $ts, ?array $prev): string
    {
        $tables = [];
        $primary = [];
        foreach ($ts as $t) {
            $tables[$t['name']] = true;
            foreach ($t['columns'] as $c) {
                if ($c['key'] === 'PRI') {
                    $primary[$t['name']][] = $c['name'];
                }
            }
        }
        $prevCols = [];
        $prevLabels = [];
        foreach ($prev['entities'] ?? [] as $e) {
            foreach ($e['columns'] as $c) {
                $prevCols[$e['name'] . '.' . $c['name']] = $c;
            }
        }
        foreach ($prev['relations'] ?? [] as $r) {
            $prevLabels[$r['parent'] . '/' . $r['child'] . '/' . implode(',', $r['fks'])] = $r;
        }
        $sb = "erDiagram\n";
        $rels = [];
        $directives = [];
        foreach ($ts as $t) {
            $sb .= '  ' . $t['name'] . " {\n";
            $single = [];
            foreach ($t['indexes'] as $ix) {
                if (count($ix['columns']) === 1) {
                    $single[$ix['columns'][0]] = $ix;
                }
            }
            $foreignByColumn = [];
            foreach ($t['foreign_keys'] as $fk) {
                if (count($fk['columns']) !== count($fk['target_columns'])) {
                    continue;
                }
                foreach ($fk['columns'] as $i => $column) {
                    $foreignByColumn[$column] = [$fk, $i];
                }
                if ($fk['target'] !== $t['name'] && ($primary[$fk['target']] ?? []) === $fk['target_columns']) {
                    $rels[] = ['parent' => $fk['target'], 'child' => $t['name'], 'fks' => $fk['columns'], 'on_delete' => $fk['on_delete']];
                }
            }
            foreach ($t['columns'] as $c) {
                [$typ, $unsigned] = self::mermaidType($c['type']);
                $typ = self::importedJsonText($c['name'], $typ);
                $keys = [];
                if ($c['key'] === 'PRI') {
                    $keys[] = 'PK';
                }
                $target = isset($foreignByColumn[$c['name']]) ? $foreignByColumn[$c['name']][0]['target'] : self::fkTarget($c['name'], $tables);
                if ($target !== '' && $target !== $t['name']) {
                    $keys[] = 'FK';
                }
                if (isset($single[$c['name']]) && $single[$c['name']]['unique'] && $c['key'] !== 'PRI') {
                    $keys[] = 'UK';
                }
                $attrs = [];
                if ($c['nullable']) {
                    $attrs[] = '?';
                }
                $d = $c['default'];
                if ($d === null) {
                } elseif (str_starts_with(strtoupper($d), 'CURRENT_TIMESTAMP')) {
                    $attrs[] = '=now';
                } elseif ($c['nullable'] && strcasecmp($d, 'NULL') === 0) {
                } else {
                    if (str_contains($d, ' ') || (!SchemaDdl::isNumber($d) && !str_starts_with($d, "'"))) {
                        $d = "'" . $d . "'";
                    }
                    $attrs[] = '=' . $d;
                }
                if (str_contains(strtolower($c['extra']), 'on update current_timestamp')) {
                    $attrs[] = 'onupdate';
                }
                if (str_contains($c['extra'], 'auto_increment')) {
                    $attrs[] = 'auto';
                }
                if ($unsigned && !str_starts_with($c['name'], 'is_')) {
                    $attrs[] = 'unsigned';
                }
                $pc = $prevCols[$t['name'] . '.' . $c['name']] ?? null;
                if ($pc !== null) {
                    if ($pc['lazy']) {
                        $attrs[] = 'lazy';
                    }
                    if ($pc['bool']) {
                        $attrs[] = 'bool';
                    }
                    if ($pc['int']) {
                        $attrs[] = 'int';
                    }
                    array_push($attrs, ...$pc['styles']);
                }
                $line = sprintf('    %s %s', self::pad($typ, 13), self::pad($c['name'], 28));
                if ($keys !== []) {
                    $line .= ' ' . implode(', ', $keys);
                }
                if ($attrs !== []) {
                    $line .= ' ' . Go::quote(implode(' ', $attrs));
                }
                $sb .= rtrim($line, ' ') . "\n";
            }
            $sb .= "  }\n";
            if ($t['comment'] !== '') {
                $directives[] = "  %% table_comment {$t['name']} " . self::quoteDirective($t['comment']);
            }
            foreach ($t['columns'] as $c) {
                if ($c['comment'] !== '') {
                    $directives[] = "  %% column_comment {$t['name']} {$c['name']} " . self::quoteDirective($c['comment']);
                }
            }
            foreach ($t['indexes'] as $ix) {
                $cols = '(' . implode(', ', $ix['columns']) . ')';
                if ($ix['fulltext']) {
                    $directives[] = "  %% fulltext {$t['name']} $cols";
                } elseif ($ix['unique'] && count($ix['columns']) > 1) {
                    $directives[] = "  %% unique {$t['name']} $cols";
                } elseif ($ix['unique']) {
                    // single-column unique → UK on the column line
                } elseif (count($ix['columns']) === 1 && self::fkTarget($ix['columns'][0], $tables) !== '') {
                    // single-column FK index is implied
                } else {
                    $directives[] = "  %% index {$t['name']} $cols {$ix['name']}";
                }
            }
            foreach ($t['checks'] as $check) {
                $directives[] = "  %% check {$t['name']} {$check['name']} : {$check['expr']}";
            }
        }
        if ($rels !== []) {
            $sb .= "\n";
        }
        foreach ($rels as $r) {
            $label = count($r['fks']) > 1 ? '(' . implode(', ', $r['fks']) . ')' : $r['fks'][0];
            $pr = $prevLabels[$r['parent'] . '/' . $r['child'] . '/' . implode(',', $r['fks'])] ?? null;
            if ($pr !== null && ($pr['child_name'] !== '' || $pr['parent_name'] !== '')) {
                $label .= ' (' . $pr['child_name'] . ' / ' . $pr['parent_name'] . ')';
            } elseif (count($r['fks']) > 1) {
                $label .= ' (' . $r['parent'] . ' / ' . SchemaBuilder::plural($r['child']) . ')';
            }
            if ($r['on_delete'] !== '') {
                $label .= ' ' . $r['on_delete'];
            }
            $sb .= sprintf("  %s ||--o{ %s : %s\n", self::pad($r['parent'], 14), self::pad($r['child'], 14), $label);
        }
        if ($directives !== []) {
            $sb .= "\n";
        }
        foreach ($directives as $d) {
            $sb .= $d . "\n";
        }
        return $sb;
    }

    /** Pads to a width in characters, like a %-Ns verb. */
    private static function pad(string $s, int $width): string
    {
        $n = mb_strlen($s, 'UTF-8');
        return $n >= $width ? $s : $s . str_repeat(' ', $width - $n);
    }

    private static function quoteDirective(string $s): string
    {
        return '"' . str_replace('"', '\\\\"', $s) . '"';
    }

    /** The manifest of the live tables managed by the ORM; empty when there are none. */
    public static function liveManifest(\PDO $db, string $driver): array
    {
        $tables = self::managed(self::readTables($db, $driver));
        if ($tables === []) {
            return ['schema_hash' => '', 'order' => [], 'entities' => [], 'orm' => [], 'external_fks' => [], 'immutable' => [], 'audit_log' => null, 'audits' => []];
        }
        return SchemaBuilder::build([SchemaParser::parse(self::withTriggerDirectives($db, $driver, $tables, self::renderMermaid($tables, null)))], true);
    }

    /** Appends the directives of the live ORM triggers on the imported tables to a rendered diagram. */
    public static function withTriggerDirectives(\PDO $db, string $driver, array $tables, string $text): string
    {
        $names = [];
        foreach ($tables as $t) {
            $names[$t['name']] = true;
        }
        foreach (SchemaTriggers::directives(SchemaTriggers::readBodies($db, $driver), $names) as $line) {
            $text .= '  ' . $line . "\n";
        }
        return $text;
    }

    /** Removes the migration history table from a table list. */
    public static function managed(array $tables): array
    {
        return array_values(array_filter($tables, static fn(array $t): bool => $t['name'] !== 'orm_schema_migrations' && $t['name'] !== 'orm__context'));
    }

    /**
     * The differences between a manifest and the live database that the
     * clients would get wrong.
     * @return list<string>
     */
    public static function differences(array $want, array $live): array
    {
        $out = [];
        $list = static fn(array $v): string => '[' . implode(' ', $v) . ']';
        $bool = static fn(bool $v): string => $v ? 'true' : 'false';
        foreach ($want['order'] as $name) {
            $we = $want['entities'][$name];
            $le = $live['entities'][$name] ?? null;
            if ($le === null) {
                $out[] = "{$we['table']}: table missing in the database";
                continue;
            }
            $liveCols = array_column($le['columns'], null, 'name');
            foreach ($we['columns'] as $wc) {
                $lc = $liveCols[$wc['name']] ?? null;
                if ($lc === null) {
                    $out[] = "{$we['table']}.{$wc['name']}: column missing in the database";
                    continue;
                }
                if ($wc['type'] !== $lc['type']) {
                    $out[] = "{$we['table']}.{$wc['name']}: type {$wc['type']} in manifest, {$lc['type']} in the database";
                }
                if ($wc['nullable'] !== $lc['nullable']) {
                    $out[] = "{$we['table']}.{$wc['name']}: nullable {$bool($wc['nullable'])} in manifest, {$bool($lc['nullable'])} in the database";
                }
                if ($wc['auto'] !== $lc['auto']) {
                    $out[] = "{$we['table']}.{$wc['name']}: auto_increment {$bool($wc['auto'])} in manifest, {$bool($lc['auto'])} in the database";
                }
                if (implode(',', $wc['styles']) !== implode(',', $lc['styles'])) {
                    $out[] = "{$we['table']}.{$wc['name']}: styles {$list($wc['styles'])} in manifest, {$list($lc['styles'])} in the database";
                }
            }
            foreach ($le['columns'] as $lc) {
                if (!isset($we['cols'][$lc['name']])) {
                    $out[] = "{$we['table']}.{$lc['name']}: column exists in the database but not in the manifest";
                }
            }
            if (implode(',', $we['pk'] ?? []) !== implode(',', $le['pk'] ?? [])) {
                $out[] = "{$we['table']}: primary key {$list($we['pk'] ?? [])} in manifest, {$list($le['pk'] ?? [])} in the database";
            }
        }
        return $out;
    }
}
