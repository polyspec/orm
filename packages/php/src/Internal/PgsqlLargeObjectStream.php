<?php

declare(strict_types=1);

namespace Polyspec\Orm\Internal;

use PDOException;

/**
 * PDO-compatible stream resource around an ext-pgsql large object handle.
 *
 * @internal
 */
final class PgsqlLargeObjectStream
{
    /** @var array<string, array{0: \PgSql\Lob, 1: string}> */
    private static array $pending = [];
    private static bool $registered = false;
    private static int $nextId = 0;

    /** @var resource|null The stream context that PHP's streamWrapper protocol sets on each wrapper instance. */
    public $context = null;
    private ?\PgSql\Lob $lob = null;
    private bool $eof = false;

    public static function open(\PgSql\Lob $lob, string $mode): mixed
    {
        if (!self::$registered) {
            if (!stream_wrapper_register('polyspec-pgsql-lob', self::class)) {
                throw new PDOException('cannot register PostgreSQL large-object stream wrapper');
            }
            self::$registered = true;
        }
        $id = getmypid() . '-' . (++self::$nextId);
        self::$pending[$id] = [$lob, $mode];
        // The E_WARNING of a failed open is the reason of the PDOException below; no warning leaves the ORM.
        $reason = null;
        set_error_handler(static function (int $level, string $message) use (&$reason): bool {
            $reason = $message;
            return true;
        }, E_WARNING);
        try {
            $stream = fopen('polyspec-pgsql-lob://' . $id, $mode);
        } finally {
            restore_error_handler();
        }
        unset(self::$pending[$id]);
        if (!is_resource($stream)) {
            pg_lo_close($lob);
            throw new PDOException(
                'cannot open PostgreSQL large-object stream' . ($reason === null ? '' : ": $reason"),
            );
        }
        return $stream;
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP's streamWrapper protocol requires this method name.
    public function stream_open(string $path, string $mode, int $options, ?string &$openedPath): bool
    {
        $id = parse_url($path, PHP_URL_HOST);
        if (!is_string($id) || !isset(self::$pending[$id])) {
            return false;
        }
        [$this->lob] = self::$pending[$id];
        $openedPath = $path;
        return true;
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP's streamWrapper protocol requires this method name.
    public function stream_read(int $count): string|false
    {
        if ($this->lob === null) {
            return false;
        }
        $value = pg_lo_read($this->lob, $count);
        if ($value === false) {
            return false;
        }
        $this->eof = strlen($value) < $count;
        return $value;
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP's streamWrapper protocol requires this method name.
    public function stream_write(string $data): int|false
    {
        if ($this->lob === null) {
            return false;
        }
        return pg_lo_write($this->lob, $data);
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP's streamWrapper protocol requires this method name.
    public function stream_tell(): int|false
    {
        return $this->lob === null ? false : pg_lo_tell($this->lob);
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP's streamWrapper protocol requires this method name.
    public function stream_eof(): bool
    {
        return $this->eof;
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP's streamWrapper protocol requires this method name.
    public function stream_seek(int $offset, int $whence = SEEK_SET): bool
    {
        if ($this->lob === null || !pg_lo_seek($this->lob, $offset, $whence)) {
            return false;
        }
        $this->eof = false;
        return true;
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP's streamWrapper protocol requires this method name.
    public function stream_flush(): bool
    {
        return true;
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP's streamWrapper protocol requires this method name.
    public function stream_truncate(int $newSize): bool
    {
        return $this->lob !== null && pg_lo_truncate($this->lob, $newSize);
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP's streamWrapper protocol requires this method name.
    public function stream_stat(): array|false
    {
        if ($this->lob === null) {
            return false;
        }
        $position = pg_lo_tell($this->lob);
        if ($position === false || !pg_lo_seek($this->lob, 0, SEEK_END)) {
            return false;
        }
        $size = pg_lo_tell($this->lob);
        pg_lo_seek($this->lob, $position, SEEK_SET);
        if ($size === false) {
            return false;
        }
        return ['mode' => 0100600, 2 => 0100600, 'size' => $size, 7 => $size];
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP's streamWrapper protocol requires this method name.
    public function stream_close(): void
    {
        if ($this->lob !== null) {
            pg_lo_close($this->lob);
            $this->lob = null;
        }
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- PHP's streamWrapper protocol requires this method name.
    public function stream_set_option(int $option, int $arg1, int $arg2): bool
    {
        return false;
    }
}
