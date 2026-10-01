<?php
declare(strict_types=1);

namespace Orm;

/**
 * The generated models of the process by the schema hash they were generated
 * from. A process loads the models of several schemas; the hash is computed
 * from the manifest content, so two schemas never share a hash.
 */
final class Registry
{
    /** @var array<string, array<string, class-string<Model>>> schema hash => entity => class */
    private static array $models = [];

    /** Records that the models of a schema are loaded; generated bootstrap files call it. */
    public static function generated(string $hash): void
    {
        self::$models[$hash] ??= [];
    }

    /** @param class-string<Model> $class */
    public static function register(string $class): void
    {
        $meta = $class::meta();
        $hash = $meta['schema_hash'];
        if (!isset(self::$models[$hash])) {
            throw new OrmException(Code::CONFIG, "$class is registered before the models of schema $hash are loaded");
        }
        $loaded = self::$models[$hash][$meta['entity']] ?? $class;
        if ($loaded !== $class) {
            throw new OrmException(Code::CONFIG, "entity {$meta['entity']} of schema $hash is generated as both $loaded and $class");
        }
        self::$models[$hash][$meta['entity']] = $class;
    }

    /** Whether the models of a schema are loaded. */
    public static function loaded(string $hash): bool
    {
        return isset(self::$models[$hash]);
    }

    /** @return array<string, class-string<Model>> the models of one schema by entity */
    public static function models(string $hash): array
    {
        return self::$models[$hash] ?? throw new OrmException(Code::SCHEMA_HASH_MISMATCH, "no loaded models were generated from schema $hash");
    }
}
