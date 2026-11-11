<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal Parses the URL components shared by the ORM and catalog DSN readers. */
final class DsnUrl
{
    /** The text of a DSN that is not an RFC 3986 URI of a supported scheme. */
    public const NOT_A_URI = 'dsn must be a URI using mysql://, postgres://, sqlite://, or markdown://';

    /**
     * The URL parts of the DSN and its query read by the rule of docs/spec/config.md CFG-20: the decoded values by
     * name, `_pragma` as the list of its values in written order.
     *
     * @param list<string> $accepted the parameter names of the scheme, in the order of CFG-19
     * @return array{0: array<string, mixed>, 1: array<string, string|list<string>>}
     */
    public static function parse(string $dsn, string $scheme, array $accepted): array
    {
        // The scheme is case-insensitive. An empty authority is the host "", never localhost (CFG-10); parse_url
        // refuses it, so the rest of the DSN is read after a placeholder host that no check sees.
        $prefix = strlen($scheme) + 4;
        $emptyHost = strncasecmp($dsn, $scheme . ':///', $prefix) === 0;
        $parts = self::uri($emptyHost ? $scheme . '://h/' . substr($dsn, $prefix) : $dsn, $scheme);
        if ($emptyHost) {
            $parts['host'] = '';
        }
        $query = self::query($scheme, (string) ($parts['query'] ?? ''), $accepted);
        self::host($scheme, (string) ($parts['host'] ?? ''));
        return [$parts, $query];
    }

    /**
     * The URL parts of $dsn, the first checks of CFG-20: an RFC 3986 URI, then no fragment, since a connection
     * reads no part of it and none is dropped unread.
     *
     * @return array<string, mixed>
     */
    public static function uri(string $dsn, string $scheme): array
    {
        $parts = parse_url($dsn);
        if ($parts === false) {
            throw new OrmException(Code::CONFIG, self::NOT_A_URI);
        }
        if (str_contains($dsn, '#')) {
            throw new OrmException(Code::CONFIG, "$scheme DSN has a fragment, which no connection reads");
        }
        return $parts;
    }

    /** CFG-20: a host holds no `%`, which no host name needs; it is checked after the query. */
    public static function host(string $scheme, string $host): void
    {
        if (str_contains($host, '%')) {
            throw new OrmException(
                Code::CONFIG,
                "$scheme DSN host " . Message::quote($host) . ' holds a percent escape, which no host name needs'
            );
        }
    }

    /**
     * Reads a DSN query by the rule of CFG-20. Each pair is checked in written order: a name that the scheme does
     * not accept, before its value is decoded; a repeated name (only `_pragma` repeats); a value that is not
     * percent-encoded UTF-8; an empty value or a pair without `=`; a `socket` or `host` value that holds `;` or NUL,
     * which a PDO DSN cannot hold. Each is CONFIG. An empty query has no pair; an empty pair, as in `?&a=1` or
     * `?a=1&`, has the name "", which no scheme accepts.
     *
     * @param list<string> $accepted
     * @return array<string, string|list<string>>
     */
    public static function query(string $scheme, string $query, array $accepted): array
    {
        $values = [];
        if ($query === '') {
            return $values;
        }
        foreach (explode('&', $query) as $pair) {
            $split = explode('=', $pair, 2);
            $written = $split[0];
            $name = self::decode($written);
            if ($name === null || !in_array($name, $accepted, true)) {
                throw new OrmException(
                    Code::CONFIG,
                    "$scheme DSN has the unknown parameter " . Message::quote($name ?? $written)
                        . '; it accepts ' . implode(', ', $accepted)
                );
            }
            $quoted = Message::quote($name);
            $repeats = $name === '_pragma';
            if (!$repeats && array_key_exists($name, $values)) {
                throw new OrmException(Code::CONFIG, "$scheme DSN repeats the parameter $quoted");
            }
            $value = self::decode($split[1] ?? '');
            if ($value === null) {
                throw new OrmException(Code::CONFIG, "$scheme DSN parameter $quoted is not percent-encoded UTF-8");
            }
            if ($value === '') {
                throw new OrmException(Code::CONFIG, "$scheme DSN parameter $quoted is empty");
            }
            if (($name === 'socket' || $name === 'host') && strpbrk($value, ";\0") !== false) {
                throw new OrmException(
                    Code::CONFIG,
                    "$scheme DSN parameter $quoted holds a character that a connection string cannot hold"
                );
            }
            if ($repeats) {
                $list = $values[$name] ?? [];
                $values[$name] = [...(is_array($list) ? $list : []), $value];
            } else {
                $values[$name] = $value;
            }
        }
        return $values;
    }

    /** Decodes a query name or value as an HTML form is; null when it is not percent-encoded UTF-8. */
    private static function decode(string $text): ?string
    {
        if (preg_match('/%(?![0-9A-Fa-f]{2})/', $text) === 1) {
            return null;
        }
        $decoded = urldecode($text);
        return preg_match('//u', $decoded) === 1 ? $decoded : null;
    }
}
