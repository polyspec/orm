<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * The quoting of a name or a text in an error message, which every runtime shares (INT-187, DBS-144): the
 * delimiter, then per code point the delimiter or `\` after a backslash, BEL, BS, FF, LF, CR, TAB and VT as `\a`,
 * `\b`, `\f`, `\n`, `\r`, `\t` and `\v`, any other code point below U+0020 and U+007F as `\x` and two
 * lower-case hex digits, a byte that is not part of UTF-8 as `\x` and its two lower-case hex digits, and every
 * other code point as it is; then the delimiter. The quoting needs no Unicode table.
 */
final class Message
{
    /** One well-formed UTF-8 sequence. */
    private const UTF8_CHAR = '/\G(?:[\x00-\x7F]|[\xC2-\xDF][\x80-\xBF]|\xE0[\xA0-\xBF][\x80-\xBF]|'
        . '[\xE1-\xEC\xEE\xEF][\x80-\xBF]{2}|\xED[\x80-\x9F][\x80-\xBF]|\xF0[\x90-\xBF][\x80-\xBF]{2}|'
        . '[\xF1-\xF3][\x80-\xBF]{3}|\xF4[\x80-\x8F][\x80-\xBF]{2})/';

    private function __construct()
    {
    }

    /**
     * The character at byte $offset of $text: its whole well-formed UTF-8 sequence, or the one byte there when it
     * starts none, which quote() writes as `\x` and its hex digits.
     */
    public static function character(string $text, int $offset): string
    {
        return preg_match(self::UTF8_CHAR, $text, $m, 0, $offset) === 1 ? $m[0] : $text[$offset];
    }

    public static function quote(string $text, string $delimiter = '"'): string
    {
        $out = $delimiter;
        $offset = 0;
        $length = strlen($text);
        while ($offset < $length) {
            if (preg_match(self::UTF8_CHAR, $text, $m, 0, $offset) !== 1) {
                $out .= sprintf('\\x%02x', ord($text[$offset]));
                $offset++;
                continue;
            }
            $c = $m[0];
            $offset += strlen($c);
            if (strlen($c) !== 1) {
                $out .= $c;
                continue;
            }
            $o = ord($c);
            $out .= match (true) {
                $c === $delimiter, $c === '\\' => '\\' . $c,
                $c === "\x07" => '\\a',
                $c === "\x08" => '\\b',
                $c === "\f" => '\\f',
                $c === "\n" => '\\n',
                $c === "\r" => '\\r',
                $c === "\t" => '\\t',
                $c === "\v" => '\\v',
                $o < 0x20 || $o === 0x7f => sprintf('\\x%02x', $o),
                default => $c,
            };
        }
        return $out . $delimiter;
    }
}
