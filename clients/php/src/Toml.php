<?php
declare(strict_types=1);

namespace Orm;

/**
 * A strict parser for the orm.toml subset (docs/config.md): top-level, `[table]`, and `[table.child]` keys,
 * basic "strings" with \\ \" \n \t escapes, decimal integers, booleans, `#` comments.
 * Anything else (dotted keys, arrays, inline tables, multi-line strings, duplicate keys or tables)
 * is a CONFIG error — the file is declared, not discovered.
 */
final class Toml
{
    /** @return array<string, mixed> tables as nested arrays, top-level keys as-is */
    public static function parseFile(string $path): array
    {
        if (!str_starts_with($path, '/')) {
            throw new OrmException(Code::CONFIG, "config path must be absolute: $path");
        }
        if (is_link($path)) {
            throw new OrmException(Code::CONFIG, "config path must not be a symlink: $path");
        }
        $text = @file_get_contents($path);
        if ($text === false) {
            throw new OrmException(Code::CONFIG, "cannot read $path");
        }
        try {
            return self::parse($text);
        } catch (OrmException $e) {
            throw new OrmException(Code::CONFIG, "$path: " . substr($e->getMessage(), strlen(Code::CONFIG) + 2), $e);
        }
    }

    /** @return array<string, mixed> */
    public static function parse(string $text): array
    {
        $out = [];
        $table = null;
        $declaredTables = [];
        foreach (preg_split('/\r?\n/', $text) as $i => $line) {
            $n = $i + 1;
            $line = self::stripComment($line);
            if ($line === '') {
                continue;
            }
            if ($line[0] === '[') {
                if (!preg_match('/^\[([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\]$/', $line, $m)) {
                    throw new OrmException(Code::CONFIG, "line $n: bad table header");
                }
                $path = $m[1];
                if (isset($declaredTables[$path])) {
                    throw new OrmException(Code::CONFIG, "line $n: table [$path] declared twice");
                }
                $declaredTables[$path] = true;
                $table = explode('.', $path);
                $target =& $out;
                foreach ($table as $part) {
                    if (isset($target[$part]) && !is_array($target[$part])) {
                        throw new OrmException(Code::CONFIG, "line $n: table [$path] conflicts with key $part");
                    }
                    $target[$part] ??= [];
                    $target =& $target[$part];
                }
                unset($target);
                continue;
            }
            if (!preg_match('/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/', $line, $m)) {
                throw new OrmException(Code::CONFIG, "line $n: expected key = value");
            }
            [, $key, $raw] = $m;
            $value = self::value($raw, $n);
            if ($table === null) {
                if (array_key_exists($key, $out)) {
                    throw new OrmException(Code::CONFIG, "line $n: key $key declared twice");
                }
                $out[$key] = $value;
            } else {
                $target =& $out;
                foreach ($table as $part) {
                    $target =& $target[$part];
                }
                if (array_key_exists($key, $target)) {
                    throw new OrmException(Code::CONFIG, "line $n: key " . implode('.', $table) . ".$key declared twice");
                }
                $target[$key] = $value;
                unset($target);
            }
        }
        return $out;
    }

    private static function stripComment(string $line): string
    {
        $inStr = false;
        $len = strlen($line);
        for ($i = 0; $i < $len; $i++) {
            $c = $line[$i];
            if ($inStr) {
                if ($c === '\\') {
                    $i++;
                } elseif ($c === '"') {
                    $inStr = false;
                }
            } elseif ($c === '"') {
                $inStr = true;
            } elseif ($c === '#') {
                return trim(substr($line, 0, $i));
            }
        }
        return trim($line);
    }

    private static function value(string $raw, int $n): string|int|bool
    {
        if ($raw === 'true') {
            return true;
        }
        if ($raw === 'false') {
            return false;
        }
        if (preg_match('/^[+-]?[0-9]+$/', $raw)) {
            return (int) $raw;
        }
        if ($raw[0] === '"') {
            $out = '';
            $len = strlen($raw);
            for ($i = 1; $i < $len; $i++) {
                $c = $raw[$i];
                if ($c === '"') {
                    if ($i !== $len - 1) {
                        throw new OrmException(Code::CONFIG, "line $n: trailing characters after the string");
                    }
                    return $out;
                }
                if ($c === '\\') {
                    $e = $raw[++$i] ?? '';
                    $out .= match ($e) {
                        '\\' => '\\', '"' => '"', 'n' => "\n", 't' => "\t",
                        default => throw new OrmException(Code::CONFIG, "line $n: unsupported escape \\$e"),
                    };
                    continue;
                }
                $out .= $c;
            }
            throw new OrmException(Code::CONFIG, "line $n: unterminated string");
        }
        throw new OrmException(Code::CONFIG, "line $n: unsupported value $raw (strings, integers and booleans only)");
    }
}
