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
     * The placeholders the plan cache may retain in all: one statement at the largest bind limit (MySQL and PostgreSQL,
     * 65535). A plan holds a bind descriptor per placeholder, about 390 bytes each in PHP, so a cache bounded by entry
     * count only held about 388 KB per multi-row insert entry and about 100 MB at 256 entries (limepie P-97); this
     * bound keeps it near 25 MB. The same bound holds for the statement cache of Db.
     */
    private const RETAINED_PLACEHOLDERS = 65535;

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
