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

    private static function esc(string $s): string
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $s);
    }
}
