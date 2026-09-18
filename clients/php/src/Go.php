<?php
declare(strict_types=1);

namespace Orm;

/**
 * Text forms shared with the Go tooling, so schema files and messages are
 * byte-identical across languages: quoted strings and JSON documents.
 *
 * JSON values: a PHP list is an array, a GoMap is an object with sorted keys,
 * any other PHP array is an object in insertion order, and null is null.
 */
final class Go
{
    /** A quoted string with Go escapes. */
    public static function quote(string $s): string
    {
        $out = '"';
        $n = strlen($s);
        for ($i = 0; $i < $n;) {
            $c = ord($s[$i]);
            if ($c < 0x80) {
                $out .= match ($c) {
                    0x07 => '\a', 0x08 => '\b', 0x0c => '\f', 0x0a => '\n', 0x0d => '\r', 0x09 => '\t', 0x0b => '\v',
                    0x5c => '\\\\', 0x22 => '\"',
                    default => $c < 0x20 || $c === 0x7f ? sprintf('\x%02x', $c) : chr($c),
                };
                $i++;
                continue;
            }
            $len = $c >= 0xf0 ? 4 : ($c >= 0xe0 ? 3 : ($c >= 0xc0 ? 2 : 1));
            $ch = substr($s, $i, $len);
            if ($len === 1 || !mb_check_encoding($ch, 'UTF-8')) {
                $out .= sprintf('\x%02x', $c);
                $i++;
                continue;
            }
            $cp = mb_ord($ch, 'UTF-8');
            if (preg_match('/^[\p{L}\p{M}\p{N}\p{P}\p{S}\x{20}]$/u', $ch) === 1) {
                $out .= $ch;
            } elseif ($cp < 0x10000) {
                $out .= sprintf('\u%04x', $cp);
            } else {
                $out .= sprintf('\U%08x', $cp);
            }
            $i += $len;
        }
        return $out . '"';
    }

    /** A JSON document; indent '' is the compact form. */
    public static function json(mixed $v, string $indent = ''): string
    {
        return self::encode($v, $indent, '');
    }

    private static function encode(mixed $v, string $indent, string $prefix): string
    {
        if ($v === null) {
            return 'null';
        }
        if (is_bool($v)) {
            return $v ? 'true' : 'false';
        }
        if (is_int($v)) {
            return (string) $v;
        }
        if (is_string($v)) {
            return self::string($v);
        }
        if ($v instanceof GoMap) {
            $items = $v->items;
            ksort($items, SORT_STRING);
            return self::object($items, $indent, $prefix);
        }
        if (is_array($v)) {
            if (array_is_list($v)) {
                if ($v === []) {
                    return '[]';
                }
                $inner = $prefix . $indent;
                $parts = array_map(fn($x) => self::encode($x, $indent, $inner), $v);
                if ($indent === '') {
                    return '[' . implode(',', $parts) . ']';
                }
                return "[\n$inner" . implode(",\n$inner", $parts) . "\n$prefix]";
            }
            return self::object($v, $indent, $prefix);
        }
        throw new \InvalidArgumentException('unsupported JSON value ' . get_debug_type($v));
    }

    private static function object(array $items, string $indent, string $prefix): string
    {
        if ($items === []) {
            return '{}';
        }
        $inner = $prefix . $indent;
        $parts = [];
        foreach ($items as $k => $x) {
            $parts[] = self::string((string) $k) . ($indent === '' ? ':' : ': ') . self::encode($x, $indent, $inner);
        }
        if ($indent === '') {
            return '{' . implode(',', $parts) . '}';
        }
        return "{\n$inner" . implode(",\n$inner", $parts) . "\n$prefix}";
    }

    /** A JSON string as encoding/json writes it, with HTML characters escaped. */
    private static function string(string $s): string
    {
        $out = '"';
        $n = strlen($s);
        for ($i = 0; $i < $n; $i++) {
            $c = $s[$i];
            $o = ord($c);
            if ($o < 0x80) {
                $out .= match ($o) {
                    0x22 => '\"', 0x5c => '\\\\', 0x0a => '\n', 0x0d => '\r', 0x09 => '\t', 0x08 => '\b', 0x0c => '\f',
                    0x3c => '\u003c', 0x3e => '\u003e', 0x26 => '\u0026',
                    default => $o < 0x20 ? sprintf('\u%04x', $o) : $c,
                };
                continue;
            }
            $len = $o >= 0xf0 ? 4 : ($o >= 0xe0 ? 3 : ($o >= 0xc0 ? 2 : 1));
            $ch = substr($s, $i, $len);
            if ($len === 1 || strlen($ch) !== $len || !mb_check_encoding($ch, 'UTF-8')) {
                $out .= '\ufffd';
                continue;
            }
            $out .= match ($ch) {
                "\u{2028}" => '\u2028',
                "\u{2029}" => '\u2029',
                default => $ch,
            };
            $i += $len - 1;
        }
        return $out . '"';
    }
}
