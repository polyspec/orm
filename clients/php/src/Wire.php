<?php
declare(strict_types=1);

namespace Orm;

/** Shared record definitions are installed by generated Interfaces.php. */
final class Wire
{
    /** @var array<string, array{fields: array<string,string>, optional: list<string>, union?: bool}> */
    private static array $records = [];

    public static function register(array $records): void
    {
        $raw = array_column($records, null, 'id');
        $resolved = [];
        $resolve = function (string $name) use (&$resolve, &$resolved, $raw): array {
            if (isset($resolved[$name])) { return $resolved[$name]; }
            $r = $raw[$name];
            if (isset($r['extends'])) {
                $parent = $resolve($r['extends']);
                $r['fields'] = $parent['fields'] + $r['fields'];
                $r['optional'] = array_merge($parent['optional'], $r['optional']);
            }
            return $resolved[$name] = $r;
        };
        foreach ($raw as $name => $_) { $resolve($name); }
        self::$records = $resolved;
    }

    public static function check(string $name, mixed $value, string $path = ''): void
    {
        $path = $path === '' ? $name : $path;
        $r = self::$records[$name] ?? throw new OrmException(Code::CONFIG, 'wire definitions not registered: ' . $name);
        if (!is_array($value)) { self::fail($path, 'record required'); }
        foreach ($value as $key => $v) {
            if (!array_key_exists($key, $r['fields'])) { self::fail($path . '.' . $key, 'unknown field'); }
            self::value($r['fields'][$key], $v, $path . '.' . $key);
        }
        foreach ($r['fields'] as $key => $_) {
            if (!in_array($key, $r['optional'], true) && !array_key_exists($key, $value)) { self::fail($path . '.' . $key, 'missing field'); }
        }
        if (($r['union'] ?? false) && count($value) !== 1) { self::fail($path, 'exactly one variant required'); }
    }

    private static function value(string $type, mixed $value, string $path): void
    {
        if (str_starts_with($type, 'list<')) {
            // Null list metadata is the engine's empty Go slice, not a DB value.
            if ($value === null) { return; }
            if (!is_array($value) || !array_is_list($value)) { self::fail($path, 'list required'); }
            foreach ($value as $i => $v) { self::value(substr($type, 5, -1), $v, $path . '[' . $i . ']'); }
        } elseif (str_starts_with($type, 'map<')) {
            if (!is_array($value)) { self::fail($path, 'map required'); }
            foreach ($value as $key => $v) {
                if (!is_string($key)) { self::fail($path, 'string map key required'); }
                self::value(substr($type, 4, -1), $v, $path . '.' . $key);
            }
        } elseif (isset(self::$records[$type])) {
            self::check($type, $value, $path);
        } else {
            $valid = match ($type) { 'integer' => is_int($value), 'text' => is_string($value), 'bool' => is_bool($value), default => false };
            if (!$valid) { self::fail($path, $type . ' required'); }
        }
    }

    private static function fail(string $path, string $message): never
    {
        throw new OrmException(Code::IR_INVALID, $path . ': ' . $message);
    }
}
