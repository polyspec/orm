<?php
declare(strict_types=1);

namespace Orm;

/**
 * ORM-owned triggers (audit and immutable guards). Each table's triggers form
 * one object: DDL creates it after the tables, and diff replaces it when its
 * rendered form changes and drops it before any table change.
 */
final class SchemaTriggers
{
    public const MARKER = '-- orm:';
    private const CONTEXT_MESSAGE = "'audit operation context is required'";
    private const OPERATION_MESSAGE = "'audit operation does not exist'";
    public const SQLITE_CONTEXT = 'CREATE TABLE IF NOT EXISTS "orm__context" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL);';
    private const EVENTS = ['INSERT', 'UPDATE', 'DELETE'];

    public static function auditLogMarker(array $l): string
    {
        return self::MARKER . 'audit_log operation=' . $l['operation']['table'] . '(' . implode(', ', $l['operation']['columns']) . ') context=' . $l['context']
            . ' change=' . $l['change']['table'] . '(' . implode(', ', $l['change']['columns']) . ')';
    }

    public static function auditMarker(string $table, array $a): string
    {
        $s = self::MARKER . 'audit table=' . $table . ' mode=' . $a['mode'];
        if ($a['site'] !== '') {
            $s .= ' site=' . $a['site'];
        }
        if ($a['redact'] !== []) {
            $s .= ' redact=' . implode(',', array_map(static fn(array $p): string => implode('.', $p), $a['redact']));
        }
        return $s;
    }

    private static function literal(string $s): string
    {
        return "'" . SchemaDdl::str($s) . "'";
    }

    private static function name(string $table, string $suffix, string $dialect): string
    {
        return ($dialect === 'sqlite' ? SchemaDdl::table($table, $dialect) : $table) . '_' . $suffix;
    }

    public static function audit(array $m, string $entity): ?array
    {
        foreach ($m['audits'] as $a) {
            if ($a['entity'] === $entity) {
                return $a;
            }
        }
        return null;
    }

    /** @return list<array{table: string, kind: string, drop: list<string>, create: list<string>}> */
    public static function objects(array $m, string $dialect): array
    {
        $out = [];
        foreach ($m['order'] as $name) {
            $e = $m['entities'][$name];
            $a = self::audit($m, $name);
            if ($a !== null) {
                $markers = self::auditLogMarker($m['audit_log']) . "\n" . self::auditMarker($e['table'], $a);
                $out[] = match ($dialect) {
                    'postgres' => self::postgresAudit($m, $e, $a, $markers),
                    'mysql' => self::mysqlAudit($m, $e, $a, $markers),
                    'sqlite' => self::sqliteAudit($m, $e, $a, $markers),
                    default => throw new \RuntimeException("unknown dialect \"$dialect\""),
                };
            }
            if (in_array($name, $m['immutable'], true)) {
                $out[] = self::immutable($e, $dialect);
            }
        }
        return $out;
    }

    public static function text(array $o): string
    {
        return implode("\n", $o['create']);
    }

    private static function immutable(array $e, string $dialect): array
    {
        $q = SchemaDdl::quoter($dialect);
        $o = ['table' => $e['table'], 'kind' => 'immutable', 'drop' => [], 'create' => []];
        $marker = self::MARKER . 'immutable table=' . $e['table'];
        $message = self::literal('immutable table: ' . $e['table']);
        if ($dialect === 'postgres') {
            $function = $q($e['table'] . '_immutable_reject');
            $trigger = '"' . SchemaDdl::base($e['table']) . '_immutable"';
            $o['drop'] = [
                'DROP TRIGGER IF EXISTS ' . $trigger . ' ON ' . $q($e['table']) . ';',
                'DROP FUNCTION IF EXISTS ' . $function . '();',
            ];
            $o['create'] = [
                'CREATE OR REPLACE FUNCTION ' . $function . "() RETURNS trigger LANGUAGE plpgsql AS $$\n" . $marker . "\nBEGIN RAISE EXCEPTION " . $message . "; END;\n$$;",
                'DROP TRIGGER IF EXISTS ' . $trigger . ' ON ' . $q($e['table']) . ';',
                'CREATE TRIGGER ' . $trigger . ' BEFORE UPDATE OR DELETE OR TRUNCATE ON ' . $q($e['table']) . ' FOR EACH STATEMENT EXECUTE FUNCTION ' . $function . '();',
            ];
            return $o;
        }
        foreach (['update', 'delete'] as $event) {
            $trigger = $q(self::name($e['table'], 'immutable_' . $event, $dialect));
            $o['drop'][] = 'DROP TRIGGER IF EXISTS ' . $trigger . ';';
            $o['create'][] = 'DROP TRIGGER IF EXISTS ' . $trigger . ';';
            $o['create'][] = $dialect === 'sqlite'
                ? 'CREATE TRIGGER ' . $trigger . ' BEFORE ' . strtoupper($event) . ' ON ' . $q($e['table']) . " FOR EACH ROW BEGIN\n" . $marker . "\nSELECT RAISE(ABORT, " . $message . ");\nEND;"
                : 'CREATE TRIGGER ' . $trigger . ' BEFORE ' . strtoupper($event) . ' ON ' . $q($e['table']) . " FOR EACH ROW\nBEGIN\n" . $marker . "\n  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = " . $message . ";\nEND;";
        }
        return $o;
    }

    private static function changeColumns(array $l, \Closure $q): string
    {
        return implode(', ', array_map($q, $l['change']['columns']));
    }

    private static function postgresAudit(array $m, array $e, array $a, string $markers): array
    {
        $q = SchemaDdl::quoter('postgres');
        $l = $m['audit_log'];
        $function = $q($e['table'] . '_audit');
        $base = SchemaDdl::base($e['table']);
        $trigger = '"' . $base . '_audit"';
        $truncate = '"' . $base . '_audit_truncate"';
        $b = 'CREATE OR REPLACE FUNCTION ' . $function . "() RETURNS trigger LANGUAGE plpgsql AS $$\n";
        $b .= $markers . "\n";
        $b .= "DECLARE\n  audit_operation_id text := current_setting(" . self::literal($l['context']) . ", true);\n  audit_operation_seq bigint;\n";
        if ($a['mode'] === 'changes') {
            $b .= "  audit_old jsonb := '{}'::jsonb;\n  audit_new jsonb := '{}'::jsonb;\n  audit_old_full jsonb;\n  audit_new_full jsonb;\n  audit_site text;\n  audit_key jsonb;\n";
        }
        $b .= "BEGIN\n";
        $b .= "  IF audit_operation_id IS NULL OR audit_operation_id = '' THEN RAISE EXCEPTION " . self::CONTEXT_MESSAGE . "; END IF;\n";
        $b .= '  SELECT ' . $q($l['operation']['columns'][0]) . ' INTO audit_operation_seq FROM ' . $q($l['operation']['table']) . ' WHERE ' . $q($l['operation']['columns'][1]) . "::text = audit_operation_id;\n";
        $b .= '  IF audit_operation_seq IS NULL THEN RAISE EXCEPTION ' . self::OPERATION_MESSAGE . "; END IF;\n";
        if ($a['mode'] === 'changes') {
            $b .= "  IF TG_OP = 'TRUNCATE' THEN RETURN NULL; END IF;\n";
            $b .= "  IF TG_OP <> 'INSERT' THEN audit_old := to_jsonb(OLD); END IF;\n";
            $b .= "  IF TG_OP <> 'DELETE' THEN audit_new := to_jsonb(NEW); END IF;\n";
            // A text column holding JSON, such as jsontext, is recorded as
            // JSON, as it is on MySQL and SQLite.
            foreach (self::columns($e) as $c) {
                $type = SchemaDdl::type($c, 'postgres');
                if ($type !== 'text' && !str_starts_with($type, 'varchar')) {
                    continue;
                }
                $path = self::literal('{' . $c['name'] . '}');
                $b .= "  IF TG_OP <> 'INSERT' AND OLD." . $q($c['name']) . ' IS JSON THEN audit_old := jsonb_set(audit_old, ' . $path . ', OLD.' . $q($c['name']) . "::jsonb); END IF;\n";
                $b .= "  IF TG_OP <> 'DELETE' AND NEW." . $q($c['name']) . ' IS JSON THEN audit_new := jsonb_set(audit_new, ' . $path . ', NEW.' . $q($c['name']) . "::jsonb); END IF;\n";
            }
            if ($a['site'] !== '') {
                $b .= '  audit_site := COALESCE(audit_new ->> ' . self::literal($a['site']) . ', audit_old ->> ' . self::literal($a['site']) . ");\n";
            }
            $keys = [];
            foreach ($e['pk'] as $k) {
                $keys[] = self::literal($k);
                $keys[] = 'COALESCE(audit_new -> ' . self::literal($k) . ', audit_old -> ' . self::literal($k) . ')';
            }
            $b .= '  audit_key := jsonb_build_object(' . implode(', ', $keys) . ");\n";
            $b .= "  IF TG_OP = 'UPDATE' THEN\n";
            $b .= "    audit_old_full := audit_old;\n    audit_new_full := audit_new;\n";
            $b .= "    audit_old := COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(audit_old_full) WHERE audit_new_full -> key IS DISTINCT FROM value), '{}'::jsonb);\n";
            $b .= "    audit_new := COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(audit_new_full) WHERE audit_old_full -> key IS DISTINCT FROM value), '{}'::jsonb);\n";
            $b .= "    IF audit_old = '{}'::jsonb AND audit_new = '{}'::jsonb THEN RETURN NULL; END IF;\n";
            $b .= "  END IF;\n";
            foreach ($a['redact'] as $path) {
                $p = self::literal('{' . implode(',', $path) . '}');
                foreach (['audit_new', 'audit_old'] as $v) {
                    $b .= '  IF ' . $v . ' #> ' . $p . ' IS NOT NULL THEN ' . $v . ' := jsonb_set(' . $v . ', ' . $p . ", '{\"redacted\": true, \"present\": true}'::jsonb); END IF;\n";
                }
            }
            $b .= '  INSERT INTO ' . $q($l['change']['table']) . ' (' . self::changeColumns($l, $q) . ') VALUES (audit_operation_seq, TG_OP, audit_site, ' . self::literal($e['table']) . ", audit_key, audit_old, audit_new);\n";
        }
        $b .= "  RETURN NULL;\nEND\n$$;";
        $table = $q($e['table']);
        return [
            'table' => $e['table'], 'kind' => 'audit',
            'drop' => [
                'DROP TRIGGER IF EXISTS ' . $trigger . ' ON ' . $table . ';',
                'DROP TRIGGER IF EXISTS ' . $truncate . ' ON ' . $table . ';',
                'DROP FUNCTION IF EXISTS ' . $function . '();',
            ],
            'create' => [
                $b,
                'DROP TRIGGER IF EXISTS ' . $trigger . ' ON ' . $table . ';',
                'CREATE TRIGGER ' . $trigger . ' AFTER INSERT OR UPDATE OR DELETE ON ' . $table . ' FOR EACH ROW EXECUTE FUNCTION ' . $function . '();',
                'DROP TRIGGER IF EXISTS ' . $truncate . ' ON ' . $table . ';',
                'CREATE TRIGGER ' . $truncate . ' BEFORE TRUNCATE ON ' . $table . ' FOR EACH STATEMENT EXECUTE FUNCTION ' . $function . '();',
            ],
        ];
    }

    /** A column value for a JSON object on MySQL and SQLite. */
    private static function value(array $c, string $ref, string $dialect): string
    {
        if ($dialect === 'sqlite') {
            return match (SchemaDdl::type($c, 'sqlite')) {
                'BLOB' => 'CASE WHEN ' . $ref . " IS NULL THEN NULL ELSE '\\x' || lower(hex(" . $ref . ')) END',
                'TEXT' => 'CASE WHEN json_valid(' . $ref . ') THEN json(' . $ref . ') ELSE ' . $ref . ' END',
                default => $ref,
            };
        }
        if ($c['type'] === 'bytes' || $c['type'] === 'inet') {
            return 'CASE WHEN ' . $ref . " IS NULL THEN NULL ELSE CONCAT(CHAR(92 USING utf8mb4), 'x', LOWER(HEX(" . $ref . '))) END';
        }
        if ($c['type'] === 'point') {
            return 'ST_AsText(' . $ref . ')';
        }
        $type = strtolower(SchemaDdl::type($c, 'mysql'));
        if (str_contains($type, 'char') || str_contains($type, 'text')) {
            return 'CAST(IF(JSON_VALID(' . $ref . '), ' . $ref . ', JSON_QUOTE(' . $ref . ')) AS JSON)';
        }
        return $ref;
    }

    /** @return list<array> the columns by name */
    private static function columns(array $e): array
    {
        $columns = $e['columns'];
        usort($columns, static fn(array $a, array $b): int => strcmp($a['name'], $b['name']));
        return $columns;
    }

    private static function rowObject(array $e, string $row, string $dialect, \Closure $q): string
    {
        $parts = [];
        foreach (self::columns($e) as $c) {
            $parts[] = self::literal($c['name']);
            $parts[] = self::value($c, $row . '.' . $q($c['name']), $dialect);
        }
        return ($dialect === 'mysql' ? 'JSON_OBJECT(' : 'json_object(') . implode(', ', $parts) . ')';
    }

    private static function unchanged(array $e, string $object, string $dialect, \Closure $q): string
    {
        $parts = [];
        foreach (self::columns($e) as $c) {
            $path = self::literal('$."' . $c['name'] . '"');
            $parts[] = $dialect === 'mysql'
                ? 'IF(NEW.' . $q($c['name']) . ' <=> OLD.' . $q($c['name']) . ', ' . $path . ", '$.\"__orm_unchanged\"')"
                : 'CASE WHEN NEW.' . $q($c['name']) . ' IS OLD.' . $q($c['name']) . ' THEN ' . $path . " ELSE '$.\"__orm_unchanged\"' END";
        }
        return ($dialect === 'mysql' ? 'JSON_REMOVE(' : 'json_remove(') . $object . ', ' . implode(', ', $parts) . ')';
    }

    private static function jsonPath(array $path): string
    {
        return self::literal('$."' . implode('"."', $path) . '"');
    }

    private static function row(string $event): string
    {
        return $event === 'DELETE' ? 'OLD' : 'NEW';
    }

    private static function key(array $e, string $event, string $dialect, \Closure $q): string
    {
        $parts = [];
        foreach ($e['pk'] as $k) {
            $c = SchemaDdl::columnOf($e, $k);
            $value = $event === 'UPDATE'
                ? 'COALESCE(' . self::value($c, 'NEW.' . $q($k), $dialect) . ', ' . self::value($c, 'OLD.' . $q($k), $dialect) . ')'
                : self::value($c, self::row($event) . '.' . $q($k), $dialect);
            $parts[] = self::literal($k);
            $parts[] = $value;
        }
        return ($dialect === 'mysql' ? 'JSON_OBJECT(' : 'json_object(') . implode(', ', $parts) . ')';
    }

    private static function site(array $a, string $event, \Closure $q): string
    {
        if ($a['site'] === '') {
            return 'NULL';
        }
        if ($event === 'UPDATE') {
            return 'COALESCE(NEW.' . $q($a['site']) . ', OLD.' . $q($a['site']) . ')';
        }
        return self::row($event) . '.' . $q($a['site']);
    }

    private static function mysqlAudit(array $m, array $e, array $a, string $markers): array
    {
        $q = SchemaDdl::quoter('mysql');
        $l = $m['audit_log'];
        $context = '@`orm.' . str_replace('`', '``', $l['context']) . '`';
        $o = ['table' => $e['table'], 'kind' => 'audit', 'drop' => [], 'create' => []];
        foreach (self::EVENTS as $event) {
            $trigger = $q(self::name($e['table'], 'audit_' . strtolower($event), 'mysql'));
            $b = 'CREATE TRIGGER ' . $trigger . ' AFTER ' . $event . ' ON ' . $q($e['table']) . " FOR EACH ROW\nBEGIN\n";
            $b .= $markers . "\n";
            $b .= "  DECLARE audit_operation_id VARCHAR(255);\n  DECLARE audit_operation_seq BIGINT;\n";
            if ($a['mode'] === 'changes') {
                $b .= "  DECLARE audit_old JSON;\n  DECLARE audit_new JSON;\n";
            }
            $b .= '  SET audit_operation_id = ' . $context . ";\n";
            $b .= "  IF COALESCE(audit_operation_id, '') = '' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = " . self::CONTEXT_MESSAGE . "; END IF;\n";
            $b .= '  SET audit_operation_seq = (SELECT ' . $q($l['operation']['columns'][0]) . ' FROM ' . $q($l['operation']['table']) . ' WHERE ' . $q($l['operation']['columns'][1]) . " = audit_operation_id LIMIT 1);\n";
            $b .= "  IF audit_operation_seq IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = " . self::OPERATION_MESSAGE . "; END IF;\n";
            if ($a['mode'] === 'changes') {
                $old = $event !== 'INSERT' ? self::rowObject($e, 'OLD', 'mysql', $q) : 'JSON_OBJECT()';
                $new = $event !== 'DELETE' ? self::rowObject($e, 'NEW', 'mysql', $q) : 'JSON_OBJECT()';
                if ($event === 'UPDATE') {
                    $old = self::unchanged($e, $old, 'mysql', $q);
                    $new = self::unchanged($e, $new, 'mysql', $q);
                }
                $b .= '  SET audit_old = ' . $old . ";\n";
                $b .= '  SET audit_new = ' . $new . ";\n";
                foreach ($a['redact'] as $path) {
                    $p = self::jsonPath($path);
                    foreach (['audit_new', 'audit_old'] as $v) {
                        $b .= '  SET ' . $v . ' = IF(JSON_CONTAINS_PATH(' . $v . ", 'one', " . $p . '), JSON_SET(' . $v . ', ' . $p . ", JSON_OBJECT('redacted', CAST('true' AS JSON), 'present', CAST('true' AS JSON))), " . $v . ");\n";
                    }
                }
                $insert = 'INSERT INTO ' . $q($l['change']['table']) . ' (' . self::changeColumns($l, $q) . ") VALUES (audit_operation_seq, '" . $event . "', " . self::site($a, $event, $q) . ', '
                    . self::literal($e['table']) . ', ' . self::key($e, $event, 'mysql', $q) . ', audit_old, audit_new);';
                $b .= $event === 'UPDATE'
                    ? "  IF JSON_LENGTH(audit_old) > 0 OR JSON_LENGTH(audit_new) > 0 THEN\n    " . $insert . "\n  END IF;\n"
                    : '  ' . $insert . "\n";
            }
            $b .= 'END;';
            $o['drop'][] = 'DROP TRIGGER IF EXISTS ' . $trigger . ';';
            $o['create'][] = 'DROP TRIGGER IF EXISTS ' . $trigger . ';';
            $o['create'][] = $b;
        }
        return $o;
    }

    private static function sqliteAudit(array $m, array $e, array $a, string $markers): array
    {
        $q = SchemaDdl::quoter('sqlite');
        $l = $m['audit_log'];
        $context = '(SELECT "value" FROM "orm__context" WHERE "key" = ' . self::literal($l['context']) . ')';
        $operation = '(SELECT ' . $q($l['operation']['columns'][0]) . ' FROM ' . $q($l['operation']['table']) . ' WHERE ' . $q($l['operation']['columns'][1]) . ' = ' . $context . ')';
        $o = ['table' => $e['table'], 'kind' => 'audit', 'drop' => [], 'create' => [self::SQLITE_CONTEXT]];
        foreach (self::EVENTS as $event) {
            $trigger = $q(self::name($e['table'], 'audit_' . strtolower($event), 'sqlite'));
            $b = 'CREATE TRIGGER ' . $trigger . ' AFTER ' . $event . ' ON ' . $q($e['table']) . " FOR EACH ROW BEGIN\n";
            $b .= $markers . "\n";
            $b .= 'SELECT RAISE(ABORT, ' . self::CONTEXT_MESSAGE . ') WHERE COALESCE(' . $context . ", '') = '';\n";
            $b .= 'SELECT RAISE(ABORT, ' . self::OPERATION_MESSAGE . ') WHERE ' . $operation . " IS NULL;\n";
            if ($a['mode'] === 'changes') {
                $old = $event !== 'INSERT' ? self::rowObject($e, 'OLD', 'sqlite', $q) : 'json_object()';
                $new = $event !== 'DELETE' ? self::rowObject($e, 'NEW', 'sqlite', $q) : 'json_object()';
                if ($event === 'UPDATE') {
                    $old = self::unchanged($e, $old, 'sqlite', $q);
                    $new = self::unchanged($e, $new, 'sqlite', $q);
                }
                $source = 'SELECT ' . $new . ' AS n, ' . $old . ' AS o';
                foreach ($a['redact'] as $path) {
                    $p = self::jsonPath($path);
                    $redacted = static fn(string $v): string => 'CASE WHEN json_type(r.' . $v . ', ' . $p . ') IS NOT NULL THEN json_set(r.' . $v . ', ' . $p
                        . ", json_object('redacted', json('true'), 'present', json('true'))) ELSE r." . $v . ' END';
                    $source = 'SELECT ' . $redacted('n') . ' AS n, ' . $redacted('o') . ' AS o FROM (' . $source . ') AS r';
                }
                $b .= 'INSERT INTO ' . $q($l['change']['table']) . ' (' . self::changeColumns($l, $q) . ') SELECT ' . $operation . ", '" . $event . "', " . self::site($a, $event, $q) . ', '
                    . self::literal($e['table']) . ', ' . self::key($e, $event, 'sqlite', $q) . ', v.o, v.n FROM (' . $source . ') AS v';
                if ($event === 'UPDATE') {
                    $b .= " WHERE v.o <> '{}' OR v.n <> '{}'";
                }
                $b .= ";\n";
            }
            $b .= 'END;';
            $o['drop'][] = 'DROP TRIGGER IF EXISTS ' . $trigger . ';';
            $o['create'][] = 'DROP TRIGGER IF EXISTS ' . $trigger . ';';
            $o['create'][] = $b;
        }
        return $o;
    }

    /**
     * The statements that drop changed trigger objects before the table
     * changes and create them after. A rebuilt SQLite table loses its
     * triggers, so its objects are always created again.
     * @param array<string, bool> $rebuilt
     * @return array{list<string>, list<string>}
     */
    public static function diff(array $from, array $to, string $dialect, array $rebuilt): array
    {
        $key = static fn(array $o): string => $o['table'] . "\0" . $o['kind'];
        $next = [];
        foreach (self::objects($to, $dialect) as $o) {
            $next[$key($o)] = $o;
        }
        $previous = [];
        $drops = [];
        foreach (self::objects($from, $dialect) as $o) {
            $previous[$key($o)] = $o;
            $n = $next[$key($o)] ?? null;
            if ($n !== null && self::text($n) === self::text($o) && !isset($rebuilt[$o['table']])) {
                continue;
            }
            array_push($drops, ...$o['drop']);
        }
        $creates = [];
        foreach ($next as $k => $o) {
            $p = $previous[$k] ?? null;
            if ($p !== null && self::text($p) === self::text($o) && !isset($rebuilt[$o['table']])) {
                continue;
            }
            $creates[] = implode("\n", $o['create']);
        }
        return [$drops, $creates];
    }

    /** Whether a live schema has the declared trigger objects, compared by table. */
    public static function same(array $want, array $live): bool
    {
        $describe = static function (array $m): array {
            $out = [];
            foreach ($m['immutable'] as $name) {
                $out[] = 'immutable ' . $m['entities'][$name]['table'];
            }
            foreach ($m['audits'] as $a) {
                $out[] = self::auditMarker($m['entities'][$a['entity']]['table'], $a);
            }
            if ($m['audit_log'] !== null) {
                $out[] = self::auditLogMarker($m['audit_log']);
            }
            sort($out, SORT_STRING);
            return $out;
        };
        return $describe($want) === $describe($live);
    }

    /**
     * Mermaid directives for the marker lines of live triggers on the imported
     * tables. Entity names are table names.
     * @param list<string> $bodies
     * @param array<string, bool> $tables
     * @return list<string>
     */
    public static function directives(array $bodies, array $tables): array
    {
        $audits = [];
        $immutables = [];
        $auditLog = '';
        $seen = [];
        foreach ($bodies as $body) {
            foreach (explode("\n", $body) as $line) {
                $line = trim($line);
                if (!str_starts_with($line, self::MARKER) || isset($seen[$line])) {
                    continue;
                }
                $seen[$line] = true;
                $directive = substr($line, strlen(self::MARKER));
                [$kind, $rest] = array_pad(explode(' ', $directive, 2), 2, '');
                if ($kind === 'audit_log') {
                    $auditLog = '%% orm:' . $directive;
                } elseif ($kind === 'audit' || $kind === 'immutable') {
                    $rest = str_starts_with($rest, 'table=') ? substr($rest, 6) : $rest;
                    [$table, $options] = array_pad(explode(' ', $rest, 2), 2, '');
                    if (!isset($tables[$table])) {
                        continue;
                    }
                    $out = '%% orm:' . $kind . ' entity=' . $table . ($options !== '' ? ' ' . $options : '');
                    if ($kind === 'audit') {
                        $audits[] = $out;
                    } else {
                        $immutables[] = $out;
                    }
                }
            }
        }
        sort($audits, SORT_STRING);
        sort($immutables, SORT_STRING);
        $out = $immutables;
        if ($audits !== [] && $auditLog !== '') {
            $out[] = $auditLog;
            array_push($out, ...$audits);
        }
        return $out;
    }

    /** @return list<string> bodies of the current schema's triggers with ORM markers */
    public static function readBodies(\PDO $pdo, string $driver): array
    {
        $sql = match ($driver) {
            'postgres' => 'SELECT p.prosrc FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = current_schema() ORDER BY c.relname, t.tgname',
            'mysql' => 'SELECT ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME',
            'sqlite' => "SELECT sql FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name, name",
            default => throw new \RuntimeException("unknown driver \"$driver\""),
        };
        $bodies = [];
        foreach ($pdo->query($sql)->fetchAll(\PDO::FETCH_COLUMN) as $body) {
            if (is_string($body) && str_contains($body, self::MARKER)) {
                $bodies[] = $body;
            }
        }
        return $bodies;
    }
}
