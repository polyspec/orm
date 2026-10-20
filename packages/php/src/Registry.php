<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * The generated models of the process are kept per manifestHash of the document set that made each model,
 * holds them. One process reads the generated models of several document sets, and each model
 * class's meta() has its own set's manifest_hash. manifestHash is the hash of the manifest
 * text, so two sets never share a hash. A set registered on the connection by schema values only
 * (install, Orm::connectSchema) has no generated class, and holds its manifest text
 * and its external text.
 */
final class Registry
{
    /** @var array<string, string> manifest hash => manifest text */
    private static array $texts = [];
    /** @var array<string, string> manifest hash => external text (the tables used from external documents) */
    private static array $externals = [];
    /** @var array<string, array<string, class-string<Model>>> manifest hash => entity => class */
    private static array $models = [];
    /** @var array<string, RuntimeModel> manifest hash => runtime model */
    private static array $runtime = [];

    /**
     * generated bootstrap.php registers the manifest hash and manifest text before the model
     * registers them. If the text does not hash to the declared hash, it fails before any statement with
     * SCHEMA_HASH_MISMATCH and registers nothing.
     */
    public static function generated(string $hash, string $text, string $external = ''): void
    {
        $actual = 'sha256:' . hash('sha256', $text . $external);
        if ($actual !== $hash) {
            throw new OrmException(Code::SCHEMA_HASH_MISMATCH,
                "generated code declares manifest $hash, its manifest text hashes to $actual: generate the models again");
        }
        self::$texts[$hash] = $text;
        self::$externals[$hash] = $external;
        self::$models[$hash] ??= [];
        // This set's runtime model is now made from the generated class's meta().
        unset(self::$runtime[$hash]);
    }

    /**
     * Remembers the manifest text and external text of the set registered on the connection with schema
     * values. That set's runtime model is made from this text even if the generated bootstrap was not
     * read. Called by Db::registerSet after it checks the values.
     */
    public static function schema(Schema $schema): void
    {
        self::$texts[$schema->manifestHash] ??= $schema->manifestText;
        self::$externals[$schema->manifestHash] ??= $schema->externalText;
    }

    /** @param class-string<Model> $class */
    public static function register(string $class): void
    {
        $meta = $class::meta();
        $hash = $meta['manifest_hash'];
        if (!isset(self::$models[$hash])) {
            throw new OrmException(Code::CONFIG, "$class is registered before the models of manifest $hash are loaded");
        }
        $loaded = self::$models[$hash][$meta['entity']] ?? $class;
        if ($loaded !== $class) {
            throw new OrmException(Code::CONFIG,
                "entity {$meta['entity']} of manifest $hash is generated as both $loaded and $class");
        }
        self::$models[$hash][$meta['entity']] = $class;
        unset(self::$runtime[$hash]);
    }

    /** Whether the generated model of the manifest hash was read. */
    public static function loaded(string $hash): bool
    {
        return isset(self::$models[$hash]);
    }

    public static function manifestText(string $hash): string
    {
        return self::$texts[$hash] ?? throw self::unloaded($hash);
    }

    /**
     * The runtime model of the manifest hash. If the set's generated bootstrap was read, the registered
     * model's meta() array; otherwise the manifest text and external text registered with schema values
     * are parsed once and made into the model. If neither exists, it is SCHEMA_HASH_MISMATCH.
     */
    public static function model(string $hash): RuntimeModel
    {
        if (isset(self::$runtime[$hash])) {
            return self::$runtime[$hash];
        }
        if (isset(self::$models[$hash])) {
            return self::$runtime[$hash] = RuntimeModel::fromModels($hash, self::$texts[$hash],
                array_values(self::$models[$hash]), self::$externals[$hash] ?? '');
        }
        $text = self::$texts[$hash] ?? throw self::unloaded($hash);
        return self::$runtime[$hash] = RuntimeModel::build(RuntimeModel::loadSet($text, self::$externals[$hash] ?? ''));
    }

    /** @return array<string, class-string<Model>> The model of one document set, per entity. */
    public static function models(string $hash): array
    {
        return self::$models[$hash] ?? throw self::unloaded($hash);
    }

    private static function unloaded(string $hash): OrmException
    {
        return new OrmException(Code::SCHEMA_HASH_MISMATCH, "no loaded generated models registered manifest $hash");
    }
}
