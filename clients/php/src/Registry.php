<?php
declare(strict_types=1);

namespace Orm;

/** The generated models of the process and the schema hash they were generated from. */
final class Registry
{
    private static ?string $hash = null;
    /** @var array<string, class-string<Model>> entity => class */
    private static array $models = [];

    public static function generated(string $hash): void
    {
        if (self::$hash !== null && self::$hash !== $hash) {
            throw new OrmException(Code::SCHEMA_HASH_MISMATCH, "models of schema $hash and " . self::$hash . ' are loaded together');
        }
        self::$hash = $hash;
    }

    /** @param class-string<Model> $class */
    public static function register(string $class): void
    {
        self::$models[$class::meta()['entity']] = $class;
    }

    public static function schemaHash(): string
    {
        return self::$hash ?? throw new OrmException(Code::CONFIG, 'no generated models are loaded');
    }

    /** @return array<string, class-string<Model>> */
    public static function models(): array
    {
        return self::$models;
    }
}
