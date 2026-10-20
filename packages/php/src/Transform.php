<?php

declare(strict_types=1);

namespace Polyspec\Orm;

final class Transform
{
    /** Executor-side value transforms, identical in every client. */
    public static function apply(string $kind, string $s): string
    {
        switch ($kind) {
            case 'like_contains':
                return '%' . self::esc($s) . '%';
            case 'like_starts':
                return self::esc($s) . '%';
            case 'like_ends':
                return '%' . self::esc($s);
        }
        return $s;
    }

    /**
     * Applies the value transform $kind to a parameter: SQL NULL binds NULL, so `col LIKE NULL` matches no row, and
     * a value other than text is CODEC_ENCODE.
     */
    public static function param(string $kind, mixed $v): ?string
    {
        if ($v === null) {
            return null;
        }
        if (!is_string($v)) {
            throw new OrmException(Code::CODEC_ENCODE, "$kind requires a string value");
        }
        return self::apply($kind, $v);
    }

    private static function esc(string $s): string
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $s);
    }
}
