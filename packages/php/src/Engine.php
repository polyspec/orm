<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * Compiles the requests of one runtime model and one database: validation, planning, and request
 * shape as the key of a size-limited plan cache.
 */
final class Engine
{
    /** @var array<string, Engine> Engine per manifest hash and dialect */
    private static array $engines = [];

    /**
     * The placeholders the plan cache may retain in all (KSTD-7-3-5): full batches of about eight tables at the SQLite
     * bind limit (999 each). A plan holds a bind descriptor per placeholder, about 410 bytes each in PHP, so this bound
     * keeps the cache near 3.2 MiB. A bound of 65535 still kept 25.6 MiB; imports grew with their rows until the cache
     * was full (limepie P-97). A plan of more placeholders is used and not cached. The same bound holds for Db's
     * statement cache.
     */
    private const RETAINED_PLACEHOLDERS = 8192;

    /** @var array<string, array> plans by request shape, least recently used first */
    private array $plans = [];
    /** @var array<string, int> the placeholders of each cached plan */
    private array $placeholders = [];
    /** The placeholders of the cached plans in all. */
    private int $retained = 0;
    private readonly Validator $validator;
    private readonly Planner $planner;

    public function __construct(public readonly RuntimeModel $model, string $dialect, private readonly int $cacheSize)
    {
        $this->validator = new Validator($model);
        $this->planner = new Planner($model, new Dialect($dialect));
    }

    /**
     * The engine shared by the generated model of a manifest hash and by the dialect. The hash
     * of a generated model that has not registered it gives SCHEMA_HASH_MISMATCH.
     */
    public static function for(string $manifestHash, string $dialect, int $cacheSize): self
    {
        return self::$engines[$manifestHash . "\0" . $dialect]
            ??= new self(Registry::model($manifestHash), $dialect, $cacheSize);
    }

    /** The plan of a value-free request (docs/spec/protocol.md). */
    public function plan(array $ir): array
    {
        $this->validator->validate($ir);
        $shape = json_encode($ir, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
        if (isset($this->plans[$shape])) {
            // A hit makes the plan the most recently used one.
            $plan = $this->plans[$shape];
            unset($this->plans[$shape]);
            $this->plans[$shape] = $plan;
            return $plan;
        }
        $plan = $this->planner->compile($ir);
        Assemble::index($plan, $this->model);
        $placeholders = 0;
        foreach ($plan['steps'] as $step) {
            $placeholders += count($step['bind_slots'] ?? []);
        }
        if ($placeholders > self::RETAINED_PLACEHOLDERS) {
            return $plan;
        }
        $this->plans[$shape] = $plan;
        $this->placeholders[$shape] = $placeholders;
        $this->retained += $placeholders;
        while (count($this->plans) > $this->cacheSize || $this->retained > self::RETAINED_PLACEHOLDERS) {
            $oldest = (string) array_key_first($this->plans);
            $this->retained -= $this->placeholders[$oldest];
            unset($this->plans[$oldest], $this->placeholders[$oldest]);
        }
        return $plan;
    }

    /** Validates and plans a request without caching or indexing. */
    public function compile(array $ir): array
    {
        $this->validator->validate($ir);
        return $this->planner->compile($ir);
    }
}
