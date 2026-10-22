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
            case 'fulltext_boolean':
                return self::fulltextBoolean($s);
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
        if ($kind === 'fulltext_boolean' && self::fulltextBoolean($v) === '') {
            throw new OrmException(Code::IR_INVALID, 'fulltext search text has no term');
        }
        return self::apply($kind, $v);
    }

    /**
     * The transform fulltext_boolean (DIA-6): the search text of a MySQL boolean-mode match. It splits the value on
     * whitespace, removes the boolean operator characters from each term, drops the terms that are empty, prefixes every
     * term with +, suffixes the last term with *, and joins the terms with single spaces. A value with no term is ''.
     */
    public static function fulltextBoolean(string $s): string
    {
        $terms = [];
        foreach (preg_split('/\s+/u', trim($s), -1, PREG_SPLIT_NO_EMPTY) ?: [] as $word) {
            $term = str_replace(['+', '-', '<', '>', '(', ')', '~', '*', '"', '@'], '', $word);
            if ($term !== '') {
                $terms[] = '+' . $term;
            }
        }
        if ($terms === []) {
            return '';
        }
        $terms[count($terms) - 1] .= '*';
        return implode(' ', $terms);
    }

    private static function esc(string $s): string
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $s);
    }
}
