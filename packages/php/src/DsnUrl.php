<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal Parses the URL components shared by the ORM and catalog DSN readers. */
final class DsnUrl
{
    /**
     * @return array{0: array<string, mixed>, 1: array<string, mixed>}
     */
    public static function parse(string $dsn, ?string $emptyHostScheme = null): array
    {
        if ($emptyHostScheme !== null) {
            $dsn = str_replace($emptyHostScheme . ':///', $emptyHostScheme . '://localhost/', $dsn);
        }
        $parts = parse_url($dsn);
        if ($parts === false) {
            throw new OrmException(Code::CONFIG, 'invalid DSN URI');
        }
        $query = [];
        parse_str((string) ($parts['query'] ?? ''), $query);
        return [$parts, $query];
    }
}
