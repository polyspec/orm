<?php
declare(strict_types=1);

namespace Orm;

/**
 * process의 generated model을 그 model을 만든 document set의 manifestHash별로
 * 갖는다. 한 process는 여러 document set의 generated model을 읽으며, 각 model
 * class의 meta()는 자기 set의 manifest_hash를 갖는다. manifestHash는 manifest
 * text의 hash이므로 두 set이 같은 hash를 갖지 않는다.
 */
final class Registry
{
    /** @var array<string, string> manifest hash => manifest text */
    private static array $texts = [];
    /** @var array<string, string> manifest hash => external text(외부 문서에서 쓰는 table) */
    private static array $externals = [];
    /** @var array<string, array<string, class-string<Model>>> manifest hash => entity => class */
    private static array $models = [];
    /** @var array<string, RuntimeModel> manifest hash => runtime model */
    private static array $runtime = [];

    /**
     * generated bootstrap.php가 model보다 먼저 manifest hash와 manifest text를
     * 등록한다. text가 선언한 hash로 hash되지 않으면 어떤 statement보다 먼저
     * SCHEMA_HASH_MISMATCH로 실패하고 아무것도 등록하지 않는다.
     */
    public static function generated(string $hash, string $text, string $external = ''): void
    {
        $actual = 'sha256:' . hash('sha256', $text . $external);
        if ($actual !== $hash) {
            throw new OrmException(Code::SCHEMA_HASH_MISMATCH, "generated code declares manifest $hash, its manifest text hashes to $actual: generate the models again");
        }
        self::$texts[$hash] = $text;
        self::$externals[$hash] = $external;
        self::$models[$hash] ??= [];
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
            throw new OrmException(Code::CONFIG, "entity {$meta['entity']} of manifest $hash is generated as both $loaded and $class");
        }
        self::$models[$hash][$meta['entity']] = $class;
        unset(self::$runtime[$hash]);
    }

    /** manifest hash의 generated model이 읽혔는지 여부다. */
    public static function loaded(string $hash): bool
    {
        return isset(self::$models[$hash]);
    }

    public static function manifestText(string $hash): string
    {
        return self::$texts[$hash] ?? throw self::unloaded($hash);
    }

    /** 등록된 model의 meta() 배열로 만든 manifest hash의 runtime model이다. */
    public static function model(string $hash): RuntimeModel
    {
        return self::$runtime[$hash] ??= RuntimeModel::fromModels($hash, self::manifestText($hash), array_values(self::models($hash)), self::$externals[$hash] ?? '');
    }

    /** @return array<string, class-string<Model>> 한 document set의 model을 entity별로 돌려준다. */
    public static function models(string $hash): array
    {
        return self::$models[$hash] ?? throw self::unloaded($hash);
    }

    private static function unloaded(string $hash): OrmException
    {
        return new OrmException(Code::SCHEMA_HASH_MISMATCH, "no loaded generated models registered manifest $hash");
    }
}
