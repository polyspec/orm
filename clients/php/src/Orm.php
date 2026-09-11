<?php
declare(strict_types=1);

namespace Orm;

/**
 * Process-wide configuration. Everything is declared (absolute paths, keys);
 * nothing is discovered or polled.
 */
final class Orm
{
    private static ?Config $config = null;
    private static ?Transport $transport = null;

    public static function init(Config $config): void
    {
        self::$config = $config;
        self::$transport = null;
    }

    public static function config(): Config
    {
        if (self::$config === null) {
            throw new OrmException('CONFIG', 'Orm::init(Config) must be called first');
        }
        return self::$config;
    }

    public static function transport(): Transport
    {
        if (self::$transport === null) {
            self::$transport = new Transport(self::config());
        }
        return self::$transport;
    }
}

final class Config
{
    public function __construct(
        /** absolute path of the ormd unix socket */
        public readonly string $socket,
        /** absolute path of schema.json (its schema_hash is read once) */
        public readonly string $schemaPath,
        /** secret "aes" for aes/aes_hex columns */
        public readonly string $aesKey = '',
        /** called for every executed statement: fn(string $sql, array $args, float $seconds, ?\Throwable $err) */
        public readonly ?\Closure $onQuery = null,
    ) {
        if (!str_starts_with($socket, '/') || !str_starts_with($schemaPath, '/')) {
            throw new OrmException('CONFIG', 'socket and schemaPath must be absolute');
        }
    }

    private ?string $hash = null;

    public function schemaHash(): string
    {
        if ($this->hash === null) {
            $js = file_get_contents($this->schemaPath);
            if ($js === false) {
                throw new OrmException('CONFIG', "cannot read {$this->schemaPath}");
            }
            $m = json_decode($js, true);
            if (!is_array($m) || !isset($m['schema_hash'])) {
                throw new OrmException('SCHEMA_INVALID', "no schema_hash in {$this->schemaPath}");
            }
            $this->hash = (string) $m['schema_hash'];
        }
        return $this->hash;
    }
}

final class OrmException extends \RuntimeException
{
    public function __construct(public readonly string $code_, string $message)
    {
        parent::__construct($code_ . ': ' . $message);
    }
}
