<?php
declare(strict_types=1);

namespace Orm;

/**
 * Derives the schema manifest (schema.json) from parsed diagrams: canonical
 * types, keys, relation names, directives, validation, and the schema hash.
 *
 * A manifest is an array with the schema.json fields; each entity keeps a
 * `cols` index (column name → position) and each column its source `line`.
 */
final class SchemaBuilder
{
    /** Column names may not contain these underscore-separated segments. */
    public const RESERVED_SEGMENTS = ['and', 'or', 'with', 'gt', 'lt', 'ge', 'le', 'eq', 'ne', 'lk', 'lb', 'between', 'fulltext', 'tuple'];
    /** Column names may not start with these words. */
    public const RESERVED_PREFIXES = ['and', 'or', 'get', 'set', 'new', 'plus', 'minus', 'order_by', 'group_by', 'tuple', 'gt', 'lt', 'ge', 'le', 'eq', 'ne', 'lk', 'lb', 'between', 'fulltext'];
    /** Column names that are generated method names. */
    public const RESERVED_COLUMNS = ['and', 'or', 'get', 'gets', 'gets_page', 'get_query', 'limit', 'alias', 'connect', 'create', 'creates', 'update', 'delete', 'save', 'raw', 'on', 'random'];
    /** Entity names that collide with package-level names of generated models. */
    private const RESERVED_ENTITIES = ['connect', 'schema_hash'];

    private const RE_TYPE_PAREN = '/^([a-z]+)(?:\(([^)]*)\))?$/';
    private const RE_IDENT = '/^[a-z][a-z0-9_]*$/';

    private array $m;

    /**
     * @param list<array> $diagrams parsed by SchemaParser
     * @throws SchemaError
     */
    public static function build(array $diagrams, bool $allowMissingAesVersion = false): array
    {
        $b = new self();
        return $b->run($diagrams, $allowMissingAesVersion);
    }

    /**
     * Builds the manifest of Mermaid source files, sorted by path.
     * @param list<string> $sources Mermaid texts
     */
    public static function fromSources(array $sources): array
    {
        return self::build(array_map([SchemaParser::class, 'parse'], $sources));
    }

    private function run(array $diagrams, bool $allowMissingAesVersion): array
    {
        $this->m = ['schema_hash' => '', 'order' => [], 'entities' => [], 'orm' => [], 'external_fks' => [], 'immutable' => [], 'audit_log' => null, 'audits' => []];
        foreach ($diagrams as $d) {
            foreach ($d['orm'] as $x) {
                $this->m['orm'][] = $x;
            }
            foreach ($d['entities'] as $e) {
                if (isset($this->m['entities'][$e['name']])) {
                    throw new SchemaError($e['line'], 'duplicate entity ' . $e['name']);
                }
                $this->m['entities'][$e['name']] = $this->entity($e);
                $this->m['order'][] = $e['name'];
            }
        }
        foreach ($diagrams as $d) {
            foreach ($d['orm'] as $x) {
                if ($x['kind'] !== 'table') {
                    continue;
                }
                $entity = $x['args']['entity'] ?? '';
                $name = $x['args']['name'] ?? '';
                if (!isset($this->m['entities'][$entity])) {
                    throw new SchemaError($x['line'], '%% orm:table: unknown entity ' . $entity);
                }
                if (!self::qualifiedTableName($name)) {
                    throw new SchemaError($x['line'], '%% orm:table: name must be schema.table: ' . $name);
                }
                if ($this->m['entities'][$entity]['table'] !== $entity) {
                    throw new SchemaError($x['line'], '%% orm:table: duplicate entity ' . $entity);
                }
                $this->m['entities'][$entity]['table'] = $name;
            }
        }
        foreach ($diagrams as $d) {
            foreach ($d['relations'] as $r) {
                $this->relation($r);
            }
        }
        foreach ($diagrams as $d) {
            foreach ($d['directives'] as $x) {
                $this->directive($x);
            }
        }
        $firstAudit = null;
        foreach ($diagrams as $d) {
            foreach ($d['orm'] as $x) {
                if ($x['kind'] === 'audit_log') {
                    $this->addAuditLog($x);
                } elseif ($x['kind'] === 'audit') {
                    $firstAudit ??= $x;
                    $this->addAudit($x);
                }
                if ($x['kind'] === 'immutable') {
                    $entity = $x['args']['entity'] ?? '';
                    if (!isset($this->m['entities'][$entity])) {
                        throw new SchemaError($x['line'], '%% orm:immutable: unknown entity ' . $entity);
                    }
                    if (!in_array($entity, $this->m['immutable'], true)) {
                        $this->m['immutable'][] = $entity;
                    }
                }
                if ($x['kind'] === 'foreign') {
                    $this->m['external_fks'][] = $this->externalFk($x);
                }
            }
        }
        $this->finishAudits($firstAudit);
        $this->validate($allowMissingAesVersion);
        $this->m['schema_hash'] = self::hash($this->m);
        return $this->m;
    }

    /**
     * Reads table(column, ...). The tables are references like the target of
     * %% orm:foreign: they may belong to another manifest installed on the same
     * connection, so only the syntax and the column count are checked.
     */
    private static function auditTable(array $x, string $option, int $width): array
    {
        if (preg_match('/^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\(([^()]*)\)$/D', $x['args'][$option] ?? '', $match) !== 1) {
            throw new SchemaError($x['line'], "%% orm:audit_log: $option must be table(column, ...)");
        }
        $columns = self::splitList($match[2]);
        if (count($columns) !== $width) {
            throw new SchemaError($x['line'], "%% orm:audit_log: $option needs $width columns");
        }
        foreach ($columns as $column) {
            if (preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/D', $column) !== 1) {
                throw new SchemaError($x['line'], "%% orm:audit_log: $option has an invalid column $column");
            }
        }
        $seen = [];
        foreach ($columns as $column) {
            if (isset($seen[$column])) {
                throw new SchemaError($x['line'], "%% orm:audit_log: $option repeats column $column");
            }
            $seen[$column] = true;
        }
        return ['table' => $match[1], 'columns' => $columns];
    }

    private function addAuditLog(array $x): void
    {
        if ($this->m['audit_log'] !== null) {
            throw new SchemaError($x['line'], '%% orm:audit_log: declared more than once');
        }
        foreach (['operation', 'context', 'change'] as $option) {
            if (($x['args'][$option] ?? '') === '') {
                throw new SchemaError($x['line'], "%% orm:audit_log: $option is required");
            }
        }
        $operation = self::auditTable($x, 'operation', 2);
        $change = self::auditTable($x, 'change', 7);
        if ($operation['table'] === $change['table']) {
            throw new SchemaError($x['line'], '%% orm:audit_log: operation and change must be different tables');
        }
        if (preg_match('/^[A-Za-z0-9_][A-Za-z0-9_.]{0,63}$/D', $x['args']['context']) !== 1) {
            throw new SchemaError($x['line'], '%% orm:audit_log: invalid context ' . $x['args']['context']);
        }
        $this->m['audit_log'] = ['operation' => $operation, 'context' => $x['args']['context'], 'change' => $change];
    }

    private function addAudit(array $x): void
    {
        $name = $x['args']['entity'] ?? '';
        $e = $this->m['entities'][$name] ?? null;
        if ($e === null) {
            throw new SchemaError($x['line'], '%% orm:audit: unknown entity ' . $name);
        }
        foreach ($this->m['audits'] as $existing) {
            if ($existing['entity'] === $name) {
                throw new SchemaError($x['line'], '%% orm:audit: entity ' . $name . ' is declared more than once');
            }
        }
        $mode = $x['args']['mode'] ?? '';
        if ($mode !== 'changes' && $mode !== 'operations') {
            throw new SchemaError($x['line'], '%% orm:audit: mode must be changes or operations');
        }
        $audit = ['entity' => $name, 'mode' => $mode, 'service' => $x['args']['service'] ?? '', 'redact' => []];
        if ($audit['service'] !== '' && !isset($e['cols'][$audit['service']])) {
            throw new SchemaError($x['line'], "%% orm:audit: unknown column $name.{$audit['service']}");
        }
        if (array_key_exists('redact', $x['args'])) {
            foreach (explode(',', $x['args']['redact']) as $item) {
                $path = explode('.', $item);
                foreach ($path as $segment) {
                    if (preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/D', $segment) !== 1) {
                        throw new SchemaError($x['line'], '%% orm:audit: invalid redact path ' . $item);
                    }
                }
                if (!isset($e['cols'][$path[0]])) {
                    throw new SchemaError($x['line'], "%% orm:audit: unknown column $name.{$path[0]}");
                }
                foreach ($audit['redact'] as $previous) {
                    $n = min(count($previous), count($path));
                    if (array_slice($previous, 0, $n) === array_slice($path, 0, $n)) {
                        throw new SchemaError($x['line'], '%% orm:audit: redact paths overlap: ' . $item);
                    }
                }
                $audit['redact'][] = $path;
            }
        }
        $this->m['audits'][] = $audit;
    }

    /** Checks the declarations that depend on each other and sorts the audits by entity. */
    private function finishAudits(?array $first): void
    {
        if ($this->m['audits'] === []) {
            return;
        }
        if ($this->m['audit_log'] === null) {
            throw new SchemaError($first['line'], '%% orm:audit requires %% orm:audit_log');
        }
        foreach ($this->m['audits'] as $audit) {
            $table = $this->m['entities'][$audit['entity']]['table'];
            if ($table === $this->m['audit_log']['operation']['table'] || $table === $this->m['audit_log']['change']['table']) {
                throw new SchemaError($first['line'], '%% orm:audit: the audit log table ' . $table . ' cannot be audited');
            }
        }
        usort($this->m['audits'], static fn(array $a, array $b): int => strcmp($a['entity'], $b['entity']));
    }

    private function externalFk(array $x): array
    {
        $entity = $x['args']['entity'] ?? '';
        $e = $this->m['entities'][$entity] ?? null;
        if ($e === null) {
            throw new SchemaError($x['line'], '%% orm:foreign: unknown entity ' . $entity);
        }
        $columns = self::splitList($x['args']['columns'] ?? '');
        if ($columns === []) {
            throw new SchemaError($x['line'], '%% orm:foreign: columns must not be empty');
        }
        foreach ($columns as $column) {
            if (!isset($e['cols'][$column])) {
                throw new SchemaError($x['line'], "% orm:foreign: unknown column $entity.$column");
            }
        }
        $reference = self::externalReference($x['args']['references'] ?? '');
        if ($reference === null || count($reference[1]) !== count($columns)) {
            throw new SchemaError($x['line'], '%% orm:foreign: references must be table(col,...) with matching columns');
        }
        $name = $x['args']['name'] ?? '';
        if ($name === '') {
            $name = 'fk_' . str_replace('.', '_', $e['table']) . '_' . implode('_', $columns);
        }
        $onDelete = $x['args']['on_delete'] ?? '';
        if ($onDelete !== '' && $onDelete !== 'cascade' && $onDelete !== 'setnull') {
            throw new SchemaError($x['line'], '%% orm:foreign: on_delete must be cascade or setnull');
        }
        $deferred = ($x['args']['deferred'] ?? '') === 'true';
        $value = $x['args']['deferred'] ?? '';
        if ($value !== '' && $value !== 'true' && $value !== 'false') {
            throw new SchemaError($x['line'], '%% orm:foreign: deferred must be true or false');
        }
        return ['entity' => $entity, 'columns' => $columns, 'target_table' => $reference[0], 'target_columns' => $reference[1], 'name' => $name, 'on_delete' => $onDelete, 'deferred' => $deferred];
    }

    /** @return list<string> */
    private static function splitList(string $value): array
    {
        $out = [];
        foreach (explode(',', $value) as $part) {
            $part = SchemaParser::trim($part);
            if ($part !== '') {
                $out[] = $part;
            }
        }
        return $out;
    }

    /** @return array{string, list<string>}|null */
    private static function externalReference(string $value): ?array
    {
        $open = strrpos($value, '(');
        if ($open === false || $open <= 0 || !str_ends_with($value, ')')) {
            return null;
        }
        $table = SchemaParser::trim(substr($value, 0, $open));
        $columns = self::splitList(substr($value, $open + 1, -1));
        return $table !== '' && $columns !== [] ? [$table, $columns] : null;
    }

    private static function qualifiedTableName(string $name): bool
    {
        $parts = explode('.', $name);
        return count($parts) === 2 && preg_match(self::RE_IDENT, $parts[0]) === 1 && preg_match(self::RE_IDENT, $parts[1]) === 1;
    }

    private function entity(array $e): array
    {
        if (preg_match(self::RE_IDENT, $e['name']) !== 1) {
            throw new SchemaError($e['line'], 'entity name must be snake_case: ' . $e['name']);
        }
        if (in_array($e['name'], self::RESERVED_ENTITIES, true)) {
            throw new SchemaError($e['line'], 'entity name is reserved by the generated models: ' . $e['name']);
        }
        $ent = ['name' => $e['name'], 'table' => $e['name'], 'renamed_from' => '', 'comment' => '', 'pk' => [], 'auto' => '', 'columns' => [], 'relations' => [],
            'unique' => [], 'indexes' => null, 'fulltext' => [], 'checks' => [], 'timestamps' => null, 'soft_delete' => '', 'aes_version' => '', 'line' => $e['line'], 'cols' => []];
        foreach ($e['columns'] as $dc) {
            $error = self::checkColumnName($dc['name']);
            if ($error !== null) {
                throw new SchemaError($dc['line'], $error);
            }
            if (isset($ent['cols'][$dc['name']])) {
                throw new SchemaError($dc['line'], 'duplicate column ' . $e['name'] . '.' . $dc['name']);
            }
            try {
                $c = self::column($dc);
            } catch (\InvalidArgumentException $ex) {
                throw new SchemaError($dc['line'], $ex->getMessage());
            }
            foreach ($dc['keys'] as $k) {
                if ($k === 'PK') {
                    $c['pk'] = true;
                    $ent['pk'][] = $c['name'];
                } elseif ($k === 'FK') {
                    $c['fk'] = true;
                } elseif ($k === 'UK') {
                    $c['uk'] = true;
                    $ent['unique'][] = [$c['name']];
                }
            }
            if ($c['auto']) {
                if ($ent['auto'] !== '') {
                    throw new SchemaError($dc['line'], 'two auto columns in ' . $e['name']);
                }
                $ent['auto'] = $c['name'];
            }
            $ent['cols'][$c['name']] = count($ent['columns']);
            $ent['columns'][] = $c;
        }
        if ($ent['pk'] === []) {
            throw new SchemaError($e['line'], 'entity ' . $e['name'] . ' has no PK');
        }
        if (isset($ent['cols']['aes_key_version'])) {
            $ent['aes_version'] = 'aes_key_version';
        }
        if (isset($ent['cols']['created_ts']) || isset($ent['cols']['updated_ts'])) {
            $ent['timestamps'] = [
                'created' => isset($ent['cols']['created_ts']) ? 'created_ts' : '',
                'updated' => isset($ent['cols']['updated_ts']) ? 'updated_ts' : '',
            ];
        }
        return $ent;
    }

    /** The column naming rule violation, or null. */
    public static function checkColumnName(string $n): ?string
    {
        if (preg_match(self::RE_IDENT, $n) !== 1) {
            return 'column name must be snake_case: ' . $n;
        }
        if (str_contains($n, '__')) {
            return "column name may not contain '__': " . $n;
        }
        foreach (explode('_', $n) as $segment) {
            if (in_array($segment, self::RESERVED_SEGMENTS, true)) {
                return 'column name may not contain the segment ' . Go::quote($segment) . ': ' . $n;
            }
        }
        if (in_array($n, self::RESERVED_COLUMNS, true)) {
            return 'column name is a reserved method name: ' . $n;
        }
        foreach (self::RESERVED_PREFIXES as $p) {
            if ($n === $p || str_starts_with($n, $p . '_')) {
                return 'column name may not start with ' . Go::quote($p) . ': ' . $n;
            }
        }
        return null;
    }

    /** Parses an integer like strconv.Atoi. */
    private static function atoi(string $s): ?int
    {
        if (preg_match('/^[+-]?[0-9]+$/', $s) !== 1) {
            return null;
        }
        $v = filter_var($s, FILTER_VALIDATE_INT);
        return $v === false ? null : $v;
    }

    private static function column(array $dc): array
    {
        $name = $dc['name'];
        $c = ['name' => $name, 'renamed_from' => '', 'type' => '', 'raw' => $dc['type'], 'nullable' => $dc['nullable'], 'default' => $dc['default'],
            'auto' => $dc['auto'], 'on_update' => $dc['onupdate'], 'unsigned' => $dc['unsigned'], 'lazy' => $dc['lazy'], 'len' => 0, 'precision' => 0,
            'scale' => 0, 'enum' => [], 'styles' => $dc['styles'], 'blind_index' => '', 'ref' => null, 'ref_explicit' => false, 'pk' => false, 'fk' => false,
            'uk' => false, 'describe' => $dc['describe'], 'comment' => '', 'line' => $dc['line']];
        if (preg_match(self::RE_TYPE_PAREN, strtolower($dc['type']), $m) !== 1) {
            throw new \InvalidArgumentException("column $name: bad type " . Go::quote($dc['type']));
        }
        $base = $m[1];
        $arg = $m[2] ?? '';
        switch ($base) {
            case 'tinyint':
            case 'smallint':
            case 'mediumint':
            case 'int':
            case 'integer':
                $c['type'] = $dc['unsigned'] ? 'i64' : 'i32';
                if ($base === 'tinyint' && ($dc['bool'] || (str_starts_with($name, 'is_') && !$dc['int']))) {
                    $c['type'] = 'bool';
                }
                break;
            case 'bigint':
                $c['type'] = 'i64';
                break;
            case 'float':
            case 'double':
            case 'real':
                $c['type'] = 'f64';
                break;
            case 'decimal':
            case 'numeric':
                $c['type'] = 'decimal';
                if ($arg !== '') {
                    $ok = str_contains($arg, '_');
                    [$p, $s] = $ok ? explode('_', $arg, 2) : [$arg, ''];
                    $precision = self::atoi($p);
                    if ($precision === null) {
                        throw new \InvalidArgumentException("column $name: decimal precision " . Go::quote($arg));
                    }
                    $c['precision'] = $precision;
                    if ($ok) {
                        $scale = self::atoi($s);
                        if ($scale === null) {
                            throw new \InvalidArgumentException("column $name: decimal scale " . Go::quote($arg));
                        }
                        $c['scale'] = $scale;
                    }
                }
                break;
            case 'varchar':
            case 'char':
                $c['type'] = 'string';
                if ($arg === '') {
                    throw new \InvalidArgumentException("column $name: $base requires a positive length");
                }
                $n = self::atoi($arg);
                if ($n === null || $n < 1) {
                    throw new \InvalidArgumentException("column $name: $base requires a positive length, got " . Go::quote($arg));
                }
                $c['len'] = $n;
                break;
            case 'uuid':
                $c['type'] = 'string';
                break;
            case 'text':
            case 'tinytext':
            case 'mediumtext':
            case 'longtext':
                $c['type'] = 'text';
                break;
            case 'blob':
            case 'tinyblob':
            case 'mediumblob':
            case 'longblob':
            case 'varbinary':
            case 'binary':
                $c['type'] = 'bytes';
                if ($arg !== '') {
                    $c['len'] = self::atoi($arg) ?? 0;
                }
                break;
            case 'date':
                $c['type'] = 'date';
                break;
            case 'time':
                $c['type'] = 'time';
                break;
            case 'datetime':
            case 'timestamp':
                $c['type'] = 'datetime';
                if ($arg !== '') {
                    $c['precision'] = self::atoi($arg) ?? 0;
                }
                break;
            case 'jsontext':
                $c['type'] = 'jsontext';
                break;
            case 'json':
                throw new SchemaError($dc['line'], "column {$dc['name']}: type json is not supported; use jsontext, which stores the ordered-json text");
            case 'enum':
                $c['type'] = 'enum';
                if ($arg === '') {
                    throw new \InvalidArgumentException("column $name: enum needs values enum(a_b_c)");
                }
                $c['enum'] = explode('_', $arg);
                break;
            case 'point':
                $c['type'] = 'point';
                break;
            case 'bool':
            case 'boolean':
                $c['type'] = 'bool';
                break;
            default:
                throw new \InvalidArgumentException("column $name: unsupported type " . Go::quote($dc['type']));
        }
        if ($c['styles'] === []) {
            $c['styles'] = match (true) {
                str_starts_with($name, 'aes_hex_') => ['aes', 'hex'],
                str_starts_with($name, 'aes_') && $name !== 'aes_key_version' => ['aes'],
                str_starts_with($name, 'gz_') => ['serialize', 'gz'],
                str_starts_with($name, 'jsons_') => ['jsons'],
                str_starts_with($name, 'json_') => ['json'],
                str_starts_with($name, 'yaml_') => ['yaml'],
                str_starts_with($name, 'base64_') => ['serialize', 'base64'],
                str_starts_with($name, 'serialize_') => ['serialize'],
                $name === 'ip' => ['ip'],
                default => [],
            };
        }
        if ($c['styles'] === ['ip']) {
            $c['type'] = 'inet';
        }
        if ($c['type'] === 'jsontext' && $c['styles'] === []) {
            $c['styles'] = ['json'];
        }
        if ($c['type'] === 'jsontext' && $c['styles'] !== ['json'] && $c['styles'] !== ['jsons']) {
            throw new \InvalidArgumentException("column $name: a jsontext column takes only the json or jsons stage; store an encrypted JSON value in a blob column with the stages json aes");
        }
        if ($name === 'aes_key_version') {
            $c['lazy'] = true;
        }
        if (!$c['lazy'] && !$dc['lazy']) {
            if ($c['type'] === 'text' || $c['type'] === 'bytes') {
                $c['lazy'] = true;
            } elseif ($c['styles'] !== [] && $c['styles'] !== ['aes', 'hex'] && $c['styles'][0] !== 'ip') {
                $c['lazy'] = true;
            }
        }
        if ($dc['ref'] !== '') {
            [$entity, $column] = explode('.', $dc['ref'], 2);
            $c['ref'] = ['entity' => $entity, 'column' => $column];
            $c['ref_explicit'] = true;
            $c['fk'] = true;
        }
        return $c;
    }

    private function &col(string $entity, string $column): array
    {
        $e = &$this->m['entities'][$entity];
        return $e['columns'][$e['cols'][$column]];
    }

    private function relation(array $r): void
    {
        $line = $r['line'];
        $where = "relation {$r['parent']} -> {$r['child']}";
        if (!isset($this->m['entities'][$r['parent']])) {
            throw new SchemaError($line, 'relation references unknown entity ' . $r['parent']);
        }
        if (!isset($this->m['entities'][$r['child']])) {
            throw new SchemaError($line, 'relation references unknown entity ' . $r['child']);
        }
        $parent = $this->m['entities'][$r['parent']];
        $child = $this->m['entities'][$r['child']];
        if (count($r['fks']) !== count($parent['pk'])) {
            throw new SchemaError($line, sprintf('%s: %d FK columns do not match %d target PK columns', $where, count($r['fks']), count($parent['pk'])));
        }
        $overlapping = false;
        foreach ($r['fks'] as $i => $name) {
            if (!isset($child['cols'][$name])) {
                throw new SchemaError($line, "$where: FK column $name not in {$r['child']}");
            }
            $fk = &$this->col($r['child'], $name);
            $fk['fk'] = true;
            if ($fk['ref'] === null) {
                $fk['ref'] = ['entity' => $parent['name'], 'column' => $parent['pk'][$i]];
            } elseif ($fk['ref']['entity'] !== $parent['name'] || $fk['ref']['column'] !== $parent['pk'][$i]) {
                if ($fk['ref_explicit']) {
                    throw new SchemaError($line, "$where: FK column $name references {$fk['ref']['entity']}.{$fk['ref']['column']}, expected {$parent['name']}.{$parent['pk'][$i]}");
                }
                $overlapping = true;
            }
            unset($fk);
        }
        $childMany = str_ends_with($r['cardinality'], '{');
        $childName = $r['child_name'];
        if ($childName === '') {
            if (count($r['fks']) !== 1) {
                throw new SchemaError($line, "$where: composite relation must name both sides");
            }
            $childName = self::trimSuffix(self::trimSuffix($r['fks'][0], '_seq'), '_id');
            if ($childName === $r['fks'][0]) {
                throw new SchemaError($line, "$where: cannot derive a name from FK {$r['fks'][0]}; write (child / parent) in the label");
            }
        }
        $parentName = $r['parent_name'];
        if ($parentName === '') {
            $base = str_starts_with($child['name'], $parent['name'] . '_') ? substr($child['name'], strlen($parent['name']) + 1) : $child['name'];
            $parentName = $childMany ? self::plural($base) : $base;
        }
        if (isset($this->m['entities'][$r['child']]['relations'][$childName])) {
            throw new SchemaError($line, "relation name {$child['name']}.$childName already used; name the sides in the label");
        }
        if (isset($this->m['entities'][$r['parent']]['relations'][$parentName])) {
            throw new SchemaError($line, "relation name {$parent['name']}.$parentName already used; name the sides in the label");
        }
        $childKeys = [];
        $parentKeys = [];
        foreach ($r['fks'] as $i => $fk) {
            $childKeys[] = ['local' => $fk, 'target' => $parent['pk'][$i]];
            $parentKeys[] = ['local' => $parent['pk'][$i], 'target' => $fk];
        }
        $this->m['entities'][$r['child']]['relations'][$childName] = ['name' => $childName, 'kind' => 'one', 'target' => $parent['name'], 'keys' => $childKeys, 'on_delete' => $r['on_delete'], 'foreign_key' => $overlapping];
        $this->m['entities'][$r['parent']]['relations'][$parentName] = ['name' => $parentName, 'kind' => $childMany ? 'many' : 'one', 'target' => $child['name'], 'keys' => $parentKeys, 'on_delete' => $r['on_delete'], 'foreign_key' => false];
    }

    private static function trimSuffix(string $s, string $suffix): string
    {
        return str_ends_with($s, $suffix) ? substr($s, 0, -strlen($suffix)) : $s;
    }

    public static function plural(string $s): string
    {
        $n = strlen($s);
        if (str_ends_with($s, 'y') && $n > 1 && !str_contains('aeiou', $s[$n - 2])) {
            return substr($s, 0, -1) . 'ies';
        }
        if (str_ends_with($s, 's') || str_ends_with($s, 'x') || str_ends_with($s, 'ch') || str_ends_with($s, 'sh')) {
            return $s . 'es';
        }
        return $s . 's';
    }

    private function directive(array $x): void
    {
        $line = $x['line'];
        if (!isset($this->m['entities'][$x['table']])) {
            throw new SchemaError($line, '%% ' . $x['kind'] . ': unknown entity ' . $x['table']);
        }
        $ent = &$this->m['entities'][$x['table']];
        foreach ($x['columns'] as $c) {
            if (!isset($ent['cols'][$c])) {
                throw new SchemaError($line, "%% {$x['kind']} {$x['table']}: unknown column $c");
            }
        }
        $col = static function (string $name) use (&$ent): ?array {
            return isset($ent['cols'][$name]) ? $ent['columns'][$ent['cols'][$name]] : null;
        };
        switch ($x['kind']) {
            case 'table_comment':
                $ent['comment'] = $x['raw'];
                break;
            case 'column_comment':
                $ent['columns'][$ent['cols'][$x['columns'][0]]]['comment'] = $x['raw'];
                break;
            case 'rename_table':
                if ($ent['renamed_from'] !== '') {
                    throw new SchemaError($line, 'rename_table declared twice for ' . $ent['name']);
                }
                $ent['renamed_from'] = $x['name'];
                break;
            case 'rename_column':
                $i = $ent['cols'][$x['columns'][0]];
                if ($ent['columns'][$i]['renamed_from'] !== '') {
                    throw new SchemaError($line, 'rename_column declared twice for ' . $ent['name'] . '.' . $ent['columns'][$i]['name']);
                }
                $ent['columns'][$i]['renamed_from'] = $x['name'];
                break;
            case 'unique':
                $ent['unique'][] = $x['columns'];
                break;
            case 'index':
                $ent['indexes'] ??= [];
                $name = $x['name'] !== '' ? $x['name'] : 'ix_' . implode('_', $x['columns']);
                if (array_key_exists($name, $ent['indexes'])) {
                    throw new SchemaError($line, 'duplicate index name ' . $name);
                }
                $ent['indexes'][$name] = $x['columns'];
                break;
            case 'fulltext':
                $ent['fulltext'][] = $x['columns'];
                break;
            case 'check':
                foreach ($ent['checks'] as $check) {
                    if ($check['name'] === $x['name']) {
                        throw new SchemaError($line, 'check ' . $x['name'] . ' declared twice');
                    }
                }
                if ($col($x['name']) !== null) {
                    throw new SchemaError($line, 'check ' . $x['name'] . ' collides with a column');
                }
                foreach (self::backtickNames($x['raw']) as $name) {
                    if ($col($name) === null) {
                        throw new SchemaError($line, 'check ' . $x['name'] . ': unknown column `' . $name . '`');
                    }
                }
                $ent['checks'][] = ['name' => $x['name'], 'expr' => $x['raw']];
                break;
            case 'timestamps':
                $ent['timestamps'] = ['created' => $x['columns'][0], 'updated' => $x['columns'][1]];
                break;
            case 'aes_version':
                if ($ent['aes_version'] !== '' && $ent['aes_version'] !== 'aes_key_version') {
                    throw new SchemaError($line, 'aes version declared twice for ' . $ent['name']);
                }
                $ent['aes_version'] = $x['columns'][0];
                break;
            case 'soft_delete':
                if ($ent['soft_delete'] !== '') {
                    throw new SchemaError($line, 'soft_delete declared twice for ' . $ent['name']);
                }
                $c = $col($x['columns'][0]);
                if ($c['type'] !== 'datetime' || !$c['nullable']) {
                    throw new SchemaError($line, 'soft_delete column ' . $x['columns'][0] . ' must be a nullable datetime');
                }
                $ent['soft_delete'] = $x['columns'][0];
                break;
            case 'blind_index':
                $encrypted = $col($x['columns'][0]);
                $index = $col($x['columns'][1]);
                if ($encrypted['name'] === $index['name']) {
                    throw new SchemaError($line, 'blind index source and target must differ');
                }
                if (!in_array('aes', $encrypted['styles'], true)) {
                    throw new SchemaError($line, "blind index source {$encrypted['name']} is not an AES column");
                }
                if (in_array('aes', $index['styles'], true)) {
                    throw new SchemaError($line, "blind index target {$index['name']} must not be an AES column");
                }
                if ($index['type'] !== 'string' && $index['type'] !== 'bytes') {
                    throw new SchemaError($line, "blind index target {$index['name']} must be string or bytes");
                }
                if ($index['type'] === 'string' && $index['len'] < 64) {
                    throw new SchemaError($line, "blind index target {$index['name']} must hold 64 hexadecimal characters");
                }
                if ($encrypted['nullable'] !== $index['nullable']) {
                    throw new SchemaError($line, "blind index target {$index['name']} nullability must match source {$encrypted['name']}");
                }
                $indexed = false;
                foreach ($ent['indexes'] ?? [] as $columns) {
                    if ($columns === [$index['name']]) {
                        $indexed = true;
                        break;
                    }
                }
                if (!$indexed) {
                    throw new SchemaError($line, "blind index target {$index['name']} requires a declared single-column index");
                }
                if ($encrypted['blind_index'] !== '') {
                    throw new SchemaError($line, "blind index source {$encrypted['name']} is declared twice");
                }
                foreach ($ent['columns'] as $other) {
                    if ($other['blind_index'] === $index['name']) {
                        throw new SchemaError($line, "blind index target {$index['name']} is declared twice");
                    }
                }
                $ent['columns'][$ent['cols'][$encrypted['name']]]['blind_index'] = $index['name'];
                break;
        }
        unset($ent);
    }

    /** @return list<string> the `quoted` identifiers of an expression */
    public static function backtickNames(string $frag): array
    {
        $out = [];
        while (true) {
            $i = strpos($frag, '`');
            if ($i === false) {
                return $out;
            }
            $j = strpos($frag, '`', $i + 1);
            if ($j === false) {
                return $out;
            }
            $out[] = substr($frag, $i + 1, $j - $i - 1);
            $frag = substr($frag, $j + 1);
        }
    }

    private function validate(bool $allowMissingAesVersion): void
    {
        $renamedTables = [];
        foreach ($this->m['order'] as $name) {
            $e = $this->m['entities'][$name];
            if ($e['renamed_from'] !== '') {
                if ($e['renamed_from'] === $e['name']) {
                    throw new SchemaError($e['line'], 'rename_table source equals target ' . $e['name']);
                }
                if (isset($renamedTables[$e['renamed_from']])) {
                    throw new SchemaError($e['line'], "rename_table source {$e['renamed_from']} is used by {$renamedTables[$e['renamed_from']]} and {$e['name']}");
                }
                $renamedTables[$e['renamed_from']] = $e['name'];
            }
            $renamedColumns = [];
            foreach ($e['columns'] as $c) {
                if ($c['renamed_from'] === '') {
                    continue;
                }
                if ($c['renamed_from'] === $c['name']) {
                    throw new SchemaError($c['line'], 'rename_column source equals target ' . $e['name'] . '.' . $c['name']);
                }
                if (isset($e['cols'][$c['renamed_from']])) {
                    throw new SchemaError($c['line'], "rename_column source {$e['name']}.{$c['renamed_from']} remains a target column");
                }
                if (isset($renamedColumns[$c['renamed_from']])) {
                    throw new SchemaError($c['line'], "rename_column source {$e['name']}.{$c['renamed_from']} is used by {$renamedColumns[$c['renamed_from']]} and {$c['name']}");
                }
                $renamedColumns[$c['renamed_from']] = $c['name'];
            }
        }
        foreach ($this->m['order'] as $name) {
            $e = $this->m['entities'][$name];
            foreach ($e['columns'] as $c) {
                if (in_array('aes', $c['styles'], true)) {
                    $version = isset($e['cols'][$e['aes_version']]) ? $e['columns'][$e['cols'][$e['aes_version']]] : null;
                    if ($version === null || $version['nullable'] || ($version['type'] !== 'i32' && $version['type'] !== 'i64')) {
                        if ($allowMissingAesVersion && $version === null) {
                            continue;
                        }
                        throw new SchemaError($e['line'], "{$e['name']}.{$c['name']} requires a non-null integer aes version column");
                    }
                }
            }
            foreach (self::goMapOrder($e['relations']) as $rn) {
                $r = $e['relations'][$rn];
                if (isset($e['cols'][$rn])) {
                    throw new SchemaError($e['line'], "relation name {$e['name']}.$rn collides with a column; name the sides in the label");
                }
                if (!isset($this->m['entities'][$r['target']])) {
                    throw new SchemaError($e['line'], 'relation target missing: ' . $r['target']);
                }
            }
            foreach ($e['columns'] as $c) {
                if ($c['ref'] !== null) {
                    $t = $this->m['entities'][$c['ref']['entity']] ?? null;
                    if ($t === null || !isset($t['cols'][$c['ref']['column']])) {
                        throw new SchemaError($c['line'], "{$e['name']}.{$c['name']} -> {$c['ref']['entity']}.{$c['ref']['column']}: target does not exist");
                    }
                }
            }
            if ($e['timestamps'] !== null) {
                foreach ([$e['timestamps']['created'], $e['timestamps']['updated']] as $ts) {
                    if ($ts !== '' && !isset($e['cols'][$ts])) {
                        throw new SchemaError($e['line'], 'timestamps column missing: ' . $e['name'] . '.' . $ts);
                    }
                }
            }
            $seen = [];
            foreach ($e['unique'] as $u) {
                $k = implode(',', $u);
                if (isset($seen[$k])) {
                    throw new SchemaError($e['line'], 'duplicate unique ' . $e['name'] . ' (' . $k . ')');
                }
                $seen[$k] = true;
            }
        }
    }

    /**
     * The relation names in an order a map walk may take. Go walks maps in
     * random order; only one relation can fail at a time in a valid source,
     * so sorted order is used.
     * @return list<string>
     */
    private static function goMapOrder(array $map): array
    {
        $keys = array_map('strval', array_keys($map));
        sort($keys, SORT_STRING);
        return $keys;
    }

    /** @return list<string> non-fatal findings: FK columns without a target */
    public static function warnings(array $m): array
    {
        $out = [];
        foreach ($m['order'] as $name) {
            $e = $m['entities'][$name];
            foreach ($e['columns'] as $c) {
                if ($c['fk'] && $c['ref'] === null) {
                    $out[] = "{$e['name']}.{$c['name']} is FK but has no relationship line or '-> table.column'";
                }
            }
        }
        return $out;
    }

    /** The schema hash: SHA-256 of the compact manifest with an empty hash, first 8 bytes. */
    public static function hash(array $m): string
    {
        $m['schema_hash'] = '';
        return substr(hash('sha256', Go::json(self::document($m))), 0, 16);
    }

    /** The schema.json text, with a trailing newline. */
    public static function json(array $m): string
    {
        return Go::json(self::document($m), '  ') . "\n";
    }

    /** Loads a schema.json produced by build and verifies its hash. */
    public static function load(string $json): array
    {
        $doc = json_decode($json, true, 512, JSON_BIGINT_AS_STRING);
        if (!is_array($doc)) {
            throw new \InvalidArgumentException('schema.json is not valid JSON: ' . json_last_error_msg());
        }
        $m = [
            'schema_hash' => (string) ($doc['schema_hash'] ?? ''),
            'order' => $doc['order'] ?? [],
            'entities' => [],
            'orm' => array_map(static fn(array $x): array => ['kind' => $x['kind'] ?? '', 'name' => $x['name'] ?? '', 'args' => $x['args'] ?? [], 'raw' => $x['raw'] ?? '', 'line' => 0], $doc['orm'] ?? []),
            'external_fks' => array_map(static fn(array $f): array => [
                'entity' => $f['entity'] ?? '', 'columns' => $f['columns'] ?? null, 'target_table' => $f['target_table'] ?? '', 'target_columns' => $f['target_columns'] ?? null,
                'name' => $f['name'] ?? '', 'on_delete' => $f['on_delete'] ?? '', 'deferred' => (bool) ($f['deferred'] ?? false),
            ], $doc['external_fks'] ?? []),
            'immutable' => $doc['immutable'] ?? [],
            'audit_log' => isset($doc['audit_log']) ? [
                'operation' => ['table' => $doc['audit_log']['operation']['table'] ?? '', 'columns' => $doc['audit_log']['operation']['columns'] ?? null],
                'context' => $doc['audit_log']['context'] ?? '',
                'change' => ['table' => $doc['audit_log']['change']['table'] ?? '', 'columns' => $doc['audit_log']['change']['columns'] ?? null],
            ] : null,
            'audits' => array_map(static fn(array $a): array => [
                'entity' => $a['entity'] ?? '', 'mode' => $a['mode'] ?? '', 'service' => $a['service'] ?? '', 'redact' => $a['redact'] ?? [],
            ], $doc['audits'] ?? []),
        ];
        foreach ($doc['entities'] ?? [] as $name => $e) {
            $m['entities'][(string) $name] = self::loadEntity($e);
        }
        $hash = self::hash($m);
        if ($hash !== $m['schema_hash']) {
            throw new \InvalidArgumentException("schema.json was edited by hand: hash {$m['schema_hash']} does not match content $hash");
        }
        return $m;
    }

    private static function loadEntity(array $e): array
    {
        $ent = [
            'name' => $e['name'] ?? '', 'table' => $e['table'] ?? '', 'renamed_from' => $e['renamed_from'] ?? '', 'comment' => $e['comment'] ?? '',
            'pk' => $e['pk'] ?? null, 'auto' => $e['auto'] ?? '', 'columns' => [], 'relations' => [], 'unique' => $e['unique'] ?? [],
            'indexes' => $e['indexes'] ?? null, 'fulltext' => $e['fulltext'] ?? [],
            'checks' => array_map(static fn(array $c): array => ['name' => $c['name'] ?? '', 'expr' => $c['expr'] ?? ''], $e['checks'] ?? []),
            'timestamps' => isset($e['timestamps']) ? ['created' => $e['timestamps']['created'] ?? '', 'updated' => $e['timestamps']['updated'] ?? ''] : null,
            'soft_delete' => $e['soft_delete'] ?? '', 'aes_version' => $e['aes_version'] ?? '', 'line' => 0, 'cols' => [],
        ];
        if (!array_key_exists('relations', $e) || $e['relations'] === null) {
            $ent['relations'] = null;
        }
        foreach ($e['relations'] ?? [] as $name => $r) {
            $ent['relations'][(string) $name] = [
                'name' => $r['name'] ?? '', 'kind' => $r['kind'] ?? '', 'target' => $r['target'] ?? '',
                'keys' => array_map(static fn(array $k): array => ['local' => $k['local'] ?? '', 'target' => $k['target'] ?? ''], $r['keys'] ?? []),
                'on_delete' => $r['on_delete'] ?? '', 'foreign_key' => (bool) ($r['foreign_key'] ?? false),
            ];
        }
        if (!array_key_exists('columns', $e) || $e['columns'] === null) {
            $ent['columns'] = null;
        }
        foreach ($e['columns'] ?? [] as $c) {
            $col = [
                'name' => $c['name'] ?? '', 'renamed_from' => $c['renamed_from'] ?? '', 'type' => $c['type'] ?? '', 'raw' => $c['raw'] ?? '',
                'nullable' => (bool) ($c['nullable'] ?? false), 'default' => array_key_exists('default', $c) ? $c['default'] : null,
                'auto' => (bool) ($c['auto'] ?? false), 'on_update' => (bool) ($c['on_update'] ?? false), 'unsigned' => (bool) ($c['unsigned'] ?? false),
                'lazy' => (bool) ($c['lazy'] ?? false), 'len' => (int) ($c['len'] ?? 0), 'precision' => (int) ($c['precision'] ?? 0), 'scale' => (int) ($c['scale'] ?? 0),
                'enum' => $c['enum'] ?? [], 'styles' => $c['styles'] ?? [], 'blind_index' => $c['blind_index'] ?? '',
                'ref' => isset($c['ref']) ? ['entity' => $c['ref']['entity'] ?? '', 'column' => $c['ref']['column'] ?? ''] : null, 'ref_explicit' => false,
                'pk' => (bool) ($c['pk'] ?? false), 'fk' => (bool) ($c['fk'] ?? false), 'uk' => (bool) ($c['uk'] ?? false),
                'describe' => $c['describe'] ?? '', 'comment' => $c['comment'] ?? '', 'line' => 0,
            ];
            $ent['cols'][$col['name']] = count($ent['columns'] ?? []);
            $ent['columns'][] = $col;
        }
        return $ent;
    }

    /** The JSON value tree of a manifest with the schema.json field order. */
    public static function document(array $m): array
    {
        $doc = ['schema_hash' => $m['schema_hash'], 'order' => $m['order'] === [] ? null : $m['order']];
        $entities = [];
        foreach ($m['entities'] as $name => $e) {
            $entities[(string) $name] = self::entityDocument($e);
        }
        $doc['entities'] = new GoMap($entities);
        if ($m['orm'] !== []) {
            $doc['orm'] = array_map(static function (array $x): array {
                $out = ['kind' => $x['kind']];
                if ($x['name'] !== '') {
                    $out['name'] = $x['name'];
                }
                if ($x['args'] !== []) {
                    $out['args'] = new GoMap($x['args']);
                }
                $out['raw'] = $x['raw'];
                return $out;
            }, $m['orm']);
        }
        if ($m['external_fks'] !== []) {
            $doc['external_fks'] = array_map(static function (array $f): array {
                $out = ['entity' => $f['entity'], 'columns' => $f['columns'], 'target_table' => $f['target_table'], 'target_columns' => $f['target_columns']];
                if ($f['name'] !== '') {
                    $out['name'] = $f['name'];
                }
                if ($f['on_delete'] !== '') {
                    $out['on_delete'] = $f['on_delete'];
                }
                if ($f['deferred']) {
                    $out['deferred'] = true;
                }
                return $out;
            }, $m['external_fks']);
        }
        if ($m['immutable'] !== []) {
            $doc['immutable'] = $m['immutable'];
        }
        if (($m['audit_log'] ?? null) !== null) {
            $doc['audit_log'] = [
                'operation' => ['table' => $m['audit_log']['operation']['table'], 'columns' => $m['audit_log']['operation']['columns']],
                'context' => $m['audit_log']['context'],
                'change' => ['table' => $m['audit_log']['change']['table'], 'columns' => $m['audit_log']['change']['columns']],
            ];
        }
        if (($m['audits'] ?? []) !== []) {
            $doc['audits'] = array_map(static function (array $a): array {
                $out = ['entity' => $a['entity'], 'mode' => $a['mode']];
                if ($a['service'] !== '') {
                    $out['service'] = $a['service'];
                }
                if ($a['redact'] !== []) {
                    $out['redact'] = $a['redact'];
                }
                return $out;
            }, $m['audits']);
        }
        return $doc;
    }

    private static function entityDocument(array $e): array
    {
        $out = ['name' => $e['name'], 'table' => $e['table']];
        self::put($out, 'renamed_from', $e['renamed_from']);
        self::put($out, 'comment', $e['comment']);
        $out['pk'] = $e['pk'] === [] ? null : $e['pk'];
        self::put($out, 'auto', $e['auto']);
        $out['columns'] = $e['columns'] === null || $e['columns'] === [] ? ($e['columns'] === null ? null : []) : array_map([self::class, 'columnDocument'], $e['columns']);
        if ($e['relations'] === null) {
            $out['relations'] = null;
        } else {
            $relations = [];
            foreach ($e['relations'] as $name => $r) {
                $rel = ['name' => $r['name'], 'kind' => $r['kind'], 'target' => $r['target'], 'keys' => $r['keys'] === [] ? null : $r['keys']];
                self::put($rel, 'on_delete', $r['on_delete']);
                if ($r['foreign_key']) {
                    $rel['foreign_key'] = true;
                }
                $relations[(string) $name] = $rel;
            }
            $out['relations'] = new GoMap($relations);
        }
        if ($e['unique'] !== []) {
            $out['unique'] = $e['unique'];
        }
        if ($e['indexes'] !== null && $e['indexes'] !== []) {
            $out['indexes'] = new GoMap($e['indexes']);
        }
        if ($e['fulltext'] !== []) {
            $out['fulltext'] = $e['fulltext'];
        }
        if ($e['checks'] !== []) {
            $out['checks'] = $e['checks'];
        }
        if ($e['timestamps'] !== null) {
            $ts = [];
            self::put($ts, 'created', $e['timestamps']['created']);
            self::put($ts, 'updated', $e['timestamps']['updated']);
            $out['timestamps'] = $ts === [] ? new GoMap() : $ts;
        }
        self::put($out, 'soft_delete', $e['soft_delete']);
        self::put($out, 'aes_version', $e['aes_version']);
        return $out;
    }

    private static function columnDocument(array $c): array
    {
        $out = ['name' => $c['name']];
        self::put($out, 'renamed_from', $c['renamed_from']);
        $out['type'] = $c['type'];
        $out['raw'] = $c['raw'];
        foreach (['nullable'] as $k) {
            if ($c[$k]) {
                $out[$k] = true;
            }
        }
        if ($c['default'] !== null) {
            $out['default'] = $c['default'];
        }
        foreach (['auto', 'on_update', 'unsigned', 'lazy'] as $k) {
            if ($c[$k]) {
                $out[$k] = true;
            }
        }
        foreach (['len', 'precision', 'scale'] as $k) {
            if ($c[$k] !== 0) {
                $out[$k] = $c[$k];
            }
        }
        if ($c['enum'] !== []) {
            $out['enum'] = $c['enum'];
        }
        if ($c['styles'] !== []) {
            $out['styles'] = $c['styles'];
        }
        self::put($out, 'blind_index', $c['blind_index']);
        if ($c['ref'] !== null) {
            $out['ref'] = ['entity' => $c['ref']['entity'], 'column' => $c['ref']['column']];
        }
        foreach (['pk', 'fk', 'uk'] as $k) {
            if ($c[$k]) {
                $out[$k] = true;
            }
        }
        self::put($out, 'describe', $c['describe']);
        self::put($out, 'comment', $c['comment']);
        return $out;
    }

    private static function put(array &$out, string $key, string $value): void
    {
        if ($value !== '') {
            $out[$key] = $value;
        }
    }
}
