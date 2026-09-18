<?php
declare(strict_types=1);

namespace Orm;

/**
 * Parses one Mermaid erDiagram schema file (docs/schema.md) into a diagram:
 * entities, relation lines, `%%` directives, and `%% orm:` extensions. It
 * accepts exactly the documented subset and rejects anything else.
 */
final class SchemaParser
{
    /** Options each `%% orm:<kind>` directive accepts. */
    private const ORM_OPTIONS = [
        'table' => ['entity', 'name'],
        'foreign' => ['entity', 'columns', 'references', 'name', 'on_delete', 'deferred'],
        'immutable' => ['entity'],
        'audit_log' => ['operation', 'context', 'change'],
        'audit' => ['entity', 'mode', 'site', 'redact'],
        'field' => ['relation', 'fk', 'public', 'required', 'order'],
        'public-key' => ['entity', 'field', 'type', 'unique', 'stable'],
        'resource-key' => ['route', 'param', 'field'],
        'route' => [],
        'path' => [],
        'scope' => ['route', 'param', 'field'],
        'filter' => ['route', 'param', 'field'],
        'operation' => ['route', 'method'],
        'permission' => ['route', 'action', 'owner'],
    ];

    private const STYLE_WORDS = ['aes', 'hex', 'gz', 'json', 'jsons', 'base64', 'serialize', 'ip', 'yaml'];

    private const RE_ENTITY_OPEN = '/^([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*$/';
    private const RE_COLUMN = '/^([A-Za-z_][A-Za-z0-9_()\[\]]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?\s*(?:"([^"]*)")?\s*$/';
    private const RE_RELATION = '/^([A-Za-z_][A-Za-z0-9_]*)\s+([|}o]{1,2}[-.]{2}[|{o]{1,2})\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/';
    private const RE_DIRECTIVE = '/^%%\s*(unique|index|fulltext|check|blind_index|timestamps|aes_version|soft_delete|table_comment|column_comment|rename_table|rename_column)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/';
    private const RE_RELATION_NAMES = '/^(?:\(\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\/\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\))?\s*(.*)$/';
    private const RE_REF = '/^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/';
    public const RE_IDENT = '/^[a-z][a-z0-9_-]*$/';
    private const RE_ORM_NAME = '/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)?$/';

    /**
     * @return array{entities: list<array>, relations: list<array>, directives: list<array>, orm: list<array>}
     * @throws SchemaError
     */
    public static function parse(string $src): array
    {
        $d = ['entities' => [], 'relations' => [], 'directives' => [], 'orm' => []];
        $cur = null;
        $lastRoute = '';
        $seenOrm = [];
        $line = 0;
        $seenHeader = false;
        foreach (self::lines($src) as $raw) {
            $line++;
            $t = self::trim($raw);
            if ($t === '') {
                continue;
            }
            if (str_starts_with($t, '%%')) {
                if (str_starts_with($t, '%% orm:')) {
                    $x = self::ormDirective($t, $line);
                    if ($x['kind'] === 'route') {
                        $lastRoute = $x['name'];
                    } elseif ($x['kind'] === 'path') {
                        if ($lastRoute === '') {
                            throw SchemaError::parse($line, '%% orm:path requires a preceding route');
                        }
                        $x['args']['route'] = $lastRoute;
                    }
                    $identity = self::ormIdentity($x);
                    if (isset($seenOrm[$identity])) {
                        throw SchemaError::parse($line, 'duplicate ORM directive ' . $identity);
                    }
                    $seenOrm[$identity] = true;
                    $d['orm'][] = $x;
                    continue;
                }
                if (preg_match(self::RE_DIRECTIVE, $t, $m) === 1) {
                    $d['directives'][] = self::directive($m, $line);
                }
                continue;
            }
            if (!$seenHeader) {
                if ($t !== 'erDiagram') {
                    throw SchemaError::parse($line, 'file must start with erDiagram');
                }
                $seenHeader = true;
                continue;
            }
            if ($cur !== null) {
                if ($t === '}') {
                    $cur = null;
                    continue;
                }
                if (preg_match(self::RE_COLUMN, $t, $m, PREG_UNMATCHED_AS_NULL) !== 1) {
                    throw SchemaError::parse($line, sprintf('bad column line in %s: %s', $d['entities'][$cur]['name'], Go::quote($t)));
                }
                $c = [
                    'type' => $m[1], 'name' => $m[2], 'keys' => [], 'comment' => $m[4] ?? '', 'line' => $line,
                    'nullable' => false, 'default' => null, 'auto' => false, 'onupdate' => false, 'unsigned' => false,
                    'bool' => false, 'int' => false, 'lazy' => false, 'styles' => [], 'ref' => '', 'describe' => '',
                ];
                if (($m[3] ?? '') !== '') {
                    foreach (explode(',', $m[3]) as $k) {
                        $c['keys'][] = self::trim($k);
                    }
                }
                try {
                    self::columnComment($c);
                } catch (\InvalidArgumentException $e) {
                    throw SchemaError::parse($line, $e->getMessage());
                }
                $d['entities'][$cur]['columns'][] = $c;
                continue;
            }
            if (preg_match(self::RE_ENTITY_OPEN, $t, $m) === 1) {
                $d['entities'][] = ['name' => $m[1], 'columns' => [], 'line' => $line];
                $cur = count($d['entities']) - 1;
                continue;
            }
            if (preg_match(self::RE_RELATION, $t, $m) === 1) {
                $r = ['parent' => $m[1], 'cardinality' => $m[2], 'child' => $m[3], 'label' => trim(self::trim($m[4]), '"'), 'line' => $line,
                    'fks' => [], 'child_name' => '', 'parent_name' => '', 'on_delete' => ''];
                try {
                    self::label($r);
                } catch (\InvalidArgumentException $e) {
                    throw SchemaError::parse($line, $e->getMessage());
                }
                $d['relations'][] = $r;
                continue;
            }
            throw SchemaError::parse($line, 'unrecognized line: ' . Go::quote($t));
        }
        if ($cur !== null) {
            throw SchemaError::parse($line, 'unterminated entity ' . $d['entities'][$cur]['name']);
        }
        if (!$seenHeader) {
            throw SchemaError::parse(0, 'empty file');
        }
        return $d;
    }

    /** @return list<string> lines as a line scanner returns them */
    private static function lines(string $src): array
    {
        if ($src === '') {
            return [];
        }
        $lines = explode("\n", $src);
        if (str_ends_with($src, "\n")) {
            array_pop($lines);
        }
        return array_map(static fn(string $l): string => str_ends_with($l, "\r") ? substr($l, 0, -1) : $l, $lines);
    }

    /** Trims ASCII and Unicode white space like strings.TrimSpace. */
    public static function trim(string $s): string
    {
        return preg_replace('/^[\s\x{85}\x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}]+|[\s\x{85}\x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}]+$/u', '', $s) ?? trim($s);
    }

    /** @return list<string> the white-space separated fields like strings.Fields */
    public static function fields(string $s): array
    {
        $parts = preg_split('/[\s\x{85}\x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}]+/u', $s, -1, PREG_SPLIT_NO_EMPTY);
        return $parts === false ? preg_split('/\s+/', $s, -1, PREG_SPLIT_NO_EMPTY) : $parts;
    }

    /**
     * Splits directive options on white space outside parentheses, so
     * `operation=core.operation(seq, operation_uuid)` stays one option.
     * @return list<string>
     */
    private static function optionFields(string $s): array
    {
        $out = [];
        $current = '';
        $depth = 0;
        foreach (mb_str_split($s) as $ch) {
            if ($ch === '(') {
                $depth++;
            } elseif ($ch === ')' && $depth > 0) {
                $depth--;
            } elseif ($depth === 0 && preg_match('/^[\s\x{85}\x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}]$/u', $ch) === 1) {
                if ($current !== '') {
                    $out[] = $current;
                    $current = '';
                }
                continue;
            }
            $current .= $ch;
        }
        if ($current !== '') {
            $out[] = $current;
        }
        return $out;
    }

    private static function ormIdentity(array $x): string
    {
        $args = $x['args'];
        if ($x['kind'] === 'field' || $x['kind'] === 'route') {
            return $x['kind'] . ':' . $x['name'];
        }
        if ($x['kind'] === 'path') {
            return $x['kind'] . ':' . ($args['route'] ?? '');
        }
        if (($args['route'] ?? '') !== '') {
            return $x['kind'] . ':' . $args['route'] . ':' . ($args['param'] ?? '') . ':' . ($args['method'] ?? '') . ':' . ($args['action'] ?? '');
        }
        if ($x['kind'] === 'public-key') {
            return $x['kind'] . ':' . ($args['entity'] ?? '') . '.' . ($args['field'] ?? '');
        }
        if ($x['kind'] === 'resource-key') {
            return $x['kind'] . ':' . ($args['route'] ?? '') . ':' . ($args['param'] ?? '');
        }
        return $x['kind'] . ':' . $x['raw'];
    }

    private static function ormDirective(string $line, int $number): array
    {
        $body = self::trim(substr($line, strlen('%% orm:')));
        if ($body === '') {
            throw SchemaError::parse($number, '%% orm:<kind> requires a directive kind');
        }
        $parts = self::optionFields($body);
        $kind = $parts[0];
        if (preg_match(self::RE_IDENT, $kind) !== 1) {
            throw SchemaError::parse($number, 'invalid ORM directive kind ' . $kind);
        }
        if (!array_key_exists($kind, self::ORM_OPTIONS)) {
            throw SchemaError::parse($number, 'unknown ORM directive ' . $kind);
        }
        $allowed = self::ORM_OPTIONS[$kind];
        $x = ['kind' => $kind, 'name' => '', 'args' => [], 'raw' => $body, 'line' => $number];
        $positional = array_slice($parts, 1);
        if ($positional !== [] && !str_contains($positional[0], '=')) {
            if (preg_match(self::RE_ORM_NAME, $positional[0]) !== 1 && $kind !== 'path') {
                throw SchemaError::parse($number, 'invalid ORM directive identifier ' . $positional[0]);
            }
            $x['name'] = $positional[0];
            $positional = array_slice($positional, 1);
        }
        foreach ($positional as $token) {
            $found = str_contains($token, '=');
            [$key, $value] = $found ? explode('=', $token, 2) : [$token, ''];
            if (!$found || preg_match(self::RE_IDENT, $key) !== 1 || $value === '') {
                throw SchemaError::parse($number, "% orm:$kind requires key=value options");
            }
            if (!in_array($key, $allowed, true)) {
                throw SchemaError::parse($number, "% orm:$kind: unknown option $key");
            }
            if (array_key_exists($key, $x['args'])) {
                throw SchemaError::parse($number, "% orm:$kind: duplicate option $key");
            }
            $x['args'][$key] = $value;
        }
        return $x;
    }

    private static function columnComment(array &$c): void
    {
        $words = self::fields($c['comment']);
        $desc = [];
        for ($i = 0; $i < count($words); $i++) {
            $w = $words[$i];
            if ($w === '?') {
                $c['nullable'] = true;
            } elseif (str_starts_with($w, '=')) {
                $c['default'] = substr($w, 1);
            } elseif ($w === 'auto') {
                $c['auto'] = true;
            } elseif ($w === 'onupdate') {
                $c['onupdate'] = true;
            } elseif ($w === 'unsigned') {
                $c['unsigned'] = true;
            } elseif ($w === 'bool') {
                $c['bool'] = true;
            } elseif ($w === 'int') {
                $c['int'] = true;
            } elseif ($w === 'lazy') {
                $c['lazy'] = true;
            } elseif ($w === '->') {
                if ($i + 1 >= count($words) || preg_match(self::RE_REF, $words[$i + 1]) !== 1) {
                    throw new \InvalidArgumentException("column {$c['name']}: '->' must be followed by table.column");
                }
                $c['ref'] = $words[$i + 1];
                $i++;
            } elseif (str_contains($w, ',')) {
                // "aes,hex": a style pipeline written compactly
                $styles = explode(',', $w);
                if (array_diff($styles, self::STYLE_WORDS) !== []) {
                    $desc[] = $w;
                    continue;
                }
                array_push($c['styles'], ...$styles);
            } elseif (in_array($w, self::STYLE_WORDS, true)) {
                $c['styles'][] = $w;
            } else {
                $desc[] = $w;
            }
        }
        $c['describe'] = implode(' ', $desc);
        if ($c['bool'] && $c['int']) {
            throw new \InvalidArgumentException("column {$c['name']}: bool and int are exclusive");
        }
    }

    private static function label(array &$r): void
    {
        $where = "relation {$r['parent']} -> {$r['child']}";
        if ($r['label'] === '') {
            throw new \InvalidArgumentException("$where: label must name the FK column");
        }
        $rest = $r['label'];
        if (str_starts_with($rest, '(')) {
            $close = strpos($rest, ')');
            if ($close === false) {
                throw new \InvalidArgumentException("$where: bad label " . Go::quote($r['label']));
            }
            foreach (explode(',', substr($rest, 1, $close - 1)) as $value) {
                $value = self::trim($value);
                if (preg_match(self::RE_IDENT, $value) !== 1) {
                    throw new \InvalidArgumentException("$where: bad FK column " . Go::quote($value));
                }
                $r['fks'][] = $value;
            }
            $rest = self::trim(substr($rest, $close + 1));
        } else {
            $fields = self::fields($rest);
            if ($fields === [] || preg_match(self::RE_IDENT, $fields[0]) !== 1) {
                throw new \InvalidArgumentException("$where: bad label " . Go::quote($r['label']));
            }
            $r['fks'] = [$fields[0]];
            $rest = self::trim(str_starts_with($rest, $fields[0]) ? substr($rest, strlen($fields[0])) : $rest);
        }
        if (preg_match(self::RE_RELATION_NAMES, $rest, $m) !== 1) {
            throw new \InvalidArgumentException("$where: bad label " . Go::quote($r['label']));
        }
        $r['child_name'] = $m[1] ?? '';
        $r['parent_name'] = $m[2] ?? '';
        foreach (self::fields($m[3] ?? '') as $w) {
            if ($w !== 'cascade' && $w !== 'setnull') {
                throw new \InvalidArgumentException("$where: unknown label word " . Go::quote($w));
            }
            $r['on_delete'] = $w;
        }
    }

    private static function directive(array $m, int $line): array
    {
        $d = ['kind' => $m[1], 'table' => $m[2], 'columns' => [], 'name' => '', 'raw' => self::trim($m[3]), 'line' => $line];
        $raw = $d['raw'];
        switch ($d['kind']) {
            case 'unique':
            case 'index':
            case 'fulltext':
                $open = strpos($raw, '(');
                $close = strrpos($raw, ')');
                if ($open !== 0 || $close === false) {
                    throw SchemaError::parse($line, "%% {$d['kind']} {$d['table']}: expected (col, …)");
                }
                foreach (explode(',', substr($raw, 1, $close - 1)) as $c) {
                    $c = self::trim($c);
                    if ($c === '') {
                        throw SchemaError::parse($line, "%% {$d['kind']} {$d['table']}: empty column");
                    }
                    $d['columns'][] = $c;
                }
                $d['name'] = self::trim(substr($raw, $close + 1));
                if ($d['kind'] !== 'index' && $d['name'] !== '') {
                    throw SchemaError::parse($line, "%% {$d['kind']}: only index takes a name");
                }
                break;
            case 'check':
                $ok = str_contains($raw, ':');
                [$name, $body] = $ok ? explode(':', $raw, 2) : [$raw, ''];
                if (!$ok || preg_match(self::RE_IDENT, self::trim($name)) !== 1 || self::trim($body) === '') {
                    throw SchemaError::parse($line, '%% check <table> <name> : <expression>');
                }
                $d['name'] = self::trim($name);
                $d['raw'] = self::trim($body);
                break;
            case 'timestamps':
                $d['columns'] = self::fields($raw);
                if (count($d['columns']) !== 2) {
                    throw SchemaError::parse($line, '%% timestamps <table> <created> <updated>');
                }
                break;
            case 'aes_version':
                $d['columns'] = self::fields($raw);
                if (count($d['columns']) !== 1 || preg_match(self::RE_IDENT, $d['columns'][0]) !== 1) {
                    throw SchemaError::parse($line, '%% aes_version <table> <version_column>');
                }
                break;
            case 'soft_delete':
                $d['columns'] = self::fields($raw);
                if (count($d['columns']) !== 1) {
                    throw SchemaError::parse($line, '%% soft_delete <table> <nullable_datetime_column>');
                }
                break;
            case 'blind_index':
                $d['columns'] = self::fields($raw);
                if (count($d['columns']) !== 2 || preg_match(self::RE_IDENT, $d['columns'][0]) !== 1 || preg_match(self::RE_IDENT, $d['columns'][1]) !== 1) {
                    throw SchemaError::parse($line, '%% blind_index <table> <encrypted_column> <index_column>');
                }
                break;
            case 'table_comment':
                if ($raw === '' || !str_starts_with($raw, '"') || !str_ends_with($raw, '"')) {
                    throw SchemaError::parse($line, '%% table_comment <table> "text"');
                }
                $d['raw'] = trim($raw, '"');
                break;
            case 'column_comment':
                $parts = self::fields($raw);
                $text = count($parts) >= 1 ? self::trim(substr($raw, strlen($parts[0]))) : '';
                if (count($parts) < 2 || !str_starts_with($text, '"') || !str_ends_with($text, '"')) {
                    throw SchemaError::parse($line, '%% column_comment <table> <column> "text"');
                }
                $d['columns'] = [$parts[0]];
                $d['raw'] = trim($text, '"');
                break;
            case 'rename_table':
                $parts = self::fields($raw);
                if (count($parts) !== 1 || preg_match(self::RE_IDENT, $parts[0]) !== 1) {
                    throw SchemaError::parse($line, '%% rename_table <new_table> <old_table>');
                }
                $d['name'] = $parts[0];
                break;
            case 'rename_column':
                $parts = self::fields($raw);
                if (count($parts) !== 2 || preg_match(self::RE_IDENT, $parts[0]) !== 1 || preg_match(self::RE_IDENT, $parts[1]) !== 1) {
                    throw SchemaError::parse($line, '%% rename_column <table> <new_column> <old_column>');
                }
                $d['columns'] = [$parts[0]];
                $d['name'] = $parts[1];
                break;
        }
        return $d;
    }
}
