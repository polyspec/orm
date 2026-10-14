<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * 한 runtime model과 한 database의 요청을 compile한다: 검증, planning, 요청
 * shape를 key로 하는 크기 제한 plan cache.
 */
final class Engine
{
    /** @var array<string, Engine> manifest hash와 dialect별 engine */
    private static array $engines = [];

    /** @var array<string, array> plans by request shape */
    private array $plans = [];
    private readonly Validator $validator;
    private readonly Planner $planner;

    public function __construct(public readonly RuntimeModel $model, string $dialect, private readonly int $cacheSize)
    {
        $this->validator = new Validator($model);
        $this->planner = new Planner($model, new Dialect($dialect));
    }

    /**
     * manifest hash의 generated model과 dialect가 공유하는 engine이다. 그 hash를
     * 등록한 generated model이 없으면 SCHEMA_HASH_MISMATCH다.
     */
    public static function for(string $manifestHash, string $dialect, int $cacheSize): self
    {
        return self::$engines[$manifestHash . "\0" . $dialect] ??= new self(Registry::model($manifestHash), $dialect, $cacheSize);
    }

    /** The plan of a value-free request (docs/protocol.md). */
    public function plan(array $ir): array
    {
        $shape = json_encode($ir, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
        if (isset($this->plans[$shape])) {
            return $this->plans[$shape];
        }
        $plan = $this->compile($ir);
        Assemble::index($plan, $this->model);
        $this->plans[$shape] = $plan;
        if (count($this->plans) > $this->cacheSize) {
            unset($this->plans[array_key_first($this->plans)]);
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
