<?php
declare(strict_types=1);

namespace Orm;

/** process의 generated model과 그 model을 만든 document set의 manifest다. */
final class Registry
{
    private static ?string $hash = null;
    private static string $text = '';
    /** @var array<string, class-string<Model>> entity => class */
    private static array $models = [];
    private static ?RuntimeModel $model = null;

    /** generated bootstrap.php가 model보다 먼저 manifest hash와 manifest text를 등록한다. */
    public static function generated(string $hash, string $text): void
    {
        if (self::$hash !== null && self::$hash !== $hash) {
            throw new OrmException(Code::SCHEMA_HASH_MISMATCH, "models of manifest $hash and " . self::$hash . ' are loaded together');
        }
        self::$hash = $hash;
        self::$text = $text;
    }

    /** @param class-string<Model> $class */
    public static function register(string $class): void
    {
        self::$models[$class::meta()['entity']] = $class;
        self::$model = null;
    }

    public static function manifestHash(): string
    {
        return self::$hash ?? throw new OrmException(Code::CONFIG, 'no generated models are loaded');
    }

    public static function manifestText(): string
    {
        self::manifestHash();
        return self::$text;
    }

    /** 등록된 model의 meta() 배열로 만든 runtime model이다. */
    public static function model(): RuntimeModel
    {
        return self::$model ??= RuntimeModel::fromModels(self::manifestHash(), self::$text, array_values(self::$models));
    }

    /** @return array<string, class-string<Model>> */
    public static function models(): array
    {
        return self::$models;
    }
}
