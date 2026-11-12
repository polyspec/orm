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
    /** @var array<string, array<string, array>> manifest hash => the parsed entities that generated code holds */
    private static array $parsed = [];
    /** @var array<class-string<Model>, true> the generated classes already compared with their entities */
    private static array $verified = [];

    /**
     * generated bootstrap.php registers the manifest hash and manifest text before the model
     * registers them. If the text does not hash to the declared hash, it fails before any statement with
     * SCHEMA_HASH_MISMATCH and registers nothing.
     */
    public static function generated(string $hash, string $text, string $external = ''): void
    {
        $actual = 'sha256:' . hash('sha256', $text . $external);
        if ($actual !== $hash) {
            throw new OrmException(
                Code::SCHEMA_HASH_MISMATCH,
                "generated code declares manifest $hash, its manifest text hashes to $actual: "
                . "generate the models again"
            );
        }
        self::$texts[$hash] = $text;
        self::$externals[$hash] = $external;
        self::$models[$hash] ??= [];
        // This set's runtime model is now made from the generated class's meta().
        unset(self::$runtime[$hash]);
    }

    /**
     * generated bootstrap.php hands over the parsed runtime model of its set, so that the process does not parse
     * the manifest. It is kept only for a manifest text registered under the same hash and in the runtime model
     * format of this library; otherwise it is ignored and the process parses the manifest.
     *
     * @internal
     * @param array<string, array> $entities
     */
    public static function parsed(string $hash, int $format, array $entities): void
    {
        if ($format === RuntimeModel::FORMAT && isset(self::$texts[$hash])) {
            self::$parsed[$hash] = $entities;
            unset(self::$runtime[$hash]);
        }
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
            throw new OrmException(
                Code::CONFIG,
                "entity {$meta['entity']} of manifest $hash is generated as both $loaded and $class"
            );
        }
        self::$models[$hash][$meta['entity']] = $class;
        unset(self::$runtime[$hash]);
    }

    /**
     * generated bootstrap.php names the class of each entity of its set. No class is loaded, so a process loads only
     * the files of the models it uses. A class is compared with its entity by verify, when a statement first uses it.
     *
     * @internal
     * @param array<string, class-string<Model>> $classes entity => class
     */
    public static function classes(string $hash, array $classes): void
    {
        if (!isset(self::$models[$hash])) {
            throw new OrmException(
                Code::CONFIG,
                implode(', ', $classes) . " registered before the models of manifest $hash are loaded"
            );
        }
        foreach ($classes as $entity => $class) {
            $loaded = self::$models[$hash][$entity] ?? $class;
            if ($loaded !== $class) {
                throw new OrmException(
                    Code::CONFIG,
                    "entity $entity of manifest $hash is generated as both $loaded and $class"
                );
            }
        }
        self::$models[$hash] += $classes;
    }

    /**
     * Compares a generated class with the parsed entity of its set, once per process. A class of a set without parsed
     * entities was compared by the runtime model of its set (RuntimeModel::fromModels).
     *
     * @internal
     * @param class-string<Model> $class
     */
    public static function verify(string $class): void
    {
        if (isset(self::$verified[$class])) {
            return;
        }
        $parsed = self::$parsed[$class::meta()['manifest_hash'] ?? ''] ?? null;
        if ($parsed !== null) {
            RuntimeModel::verifyModel($class, $parsed);
        }
        self::$verified[$class] = true;
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
     * The runtime model of the manifest hash: the parsed entities that generated code holds, which loads no class; or,
     * if the set's generated bootstrap was read without them, the registered model's meta() array; otherwise the
     * manifest text and external text registered with schema values are parsed once and made into the model. If none
     * exists, it is SCHEMA_HASH_MISMATCH.
     */
    public static function model(string $hash): RuntimeModel
    {
        if (isset(self::$runtime[$hash])) {
            return self::$runtime[$hash];
        }
        if (isset(self::$parsed[$hash])) {
            return self::$runtime[$hash] = new RuntimeModel(
                $hash,
                self::$texts[$hash],
                self::$parsed[$hash],
                self::$externals[$hash] ?? ''
            );
        }
        if (isset(self::$models[$hash])) {
            return self::$runtime[$hash] = RuntimeModel::fromModels(
                $hash,
                self::$texts[$hash],
                array_values(self::$models[$hash]),
                self::$externals[$hash] ?? ''
            );
        }
        $text = self::$texts[$hash] ?? throw self::unloaded($hash);
        return self::$runtime[$hash] = RuntimeModel::build(RuntimeModel::loadSet($text, self::$externals[$hash] ?? ''));
    }

    /** @return array<string, class-string<Model>> The model of one document set, per entity. */
    public static function models(string $hash): array
    {
        return self::$models[$hash] ?? throw self::unloaded($hash);
    }

    /**
     * The entities of a loaded document set: the parsed entities that generated code holds, which loads no class, or
     * the meta() of each registered class.
     *
     * @internal
     * @return array<string, array> entity => its fields
     */
    public static function entities(string $hash): array
    {
        return self::$parsed[$hash]
            ?? array_map(static fn(string $class): array => $class::meta(), self::models($hash));
    }

    private static function unloaded(string $hash): OrmException
    {
        return new OrmException(Code::SCHEMA_HASH_MISMATCH, "no loaded generated models registered manifest $hash");
    }
}
