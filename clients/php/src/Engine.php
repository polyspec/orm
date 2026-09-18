<?php
declare(strict_types=1);

namespace Orm;

/**
 * Compiles requests of one schema for one database: validation, planning,
 * and a bounded plan cache keyed by the request shape.
 */
final class Engine
{
    /** @var array<string, Engine> engines by schema path and dialect */
    private static array $engines = [];

    /** @var array<string, array> plans by request shape */
    private array $plans = [];
    private readonly Validator $validator;
    private readonly Planner $planner;

    public function __construct(public readonly Manifest $manifest, string $dialect, private readonly int $cacheSize)
    {
        $this->validator = new Validator($manifest);
        $this->planner = new Planner($manifest, new Dialect($dialect));
    }

    /** The shared engine of a schema file and dialect. */
    public static function for(string $schemaPath, string $dialect, int $cacheSize): self
    {
        return self::$engines[$schemaPath . "\0" . $dialect] ??= new self(Manifest::file($schemaPath), $dialect, $cacheSize);
    }

    /** The plan of a value-free request (docs/protocol.md). */
    public function plan(array $ir): array
    {
        $shape = json_encode($ir, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
        if (isset($this->plans[$shape])) {
            return $this->plans[$shape];
        }
        $plan = $this->compile($ir);
        Assemble::index($plan, hash('xxh3', $shape));
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

final class Assemble
{
    private static int $nodes = 0;

    /**
     * Stamps every step with 'plan_id' (the cache key suffix, for the on_query hook), 'decode'
     * (the styled cells Codec::decodeRows converts) and adds 'idx' => [name => position] and a
     * process-unique 'node' number to every assemble node in place. A styled column's styles are
     * split once into 'host' (aes/hex/ip, the stages the dialect left to the executor) and 'codec'
     * (docs/codec.md), in write order.
     */
    public static function index(array &$plan, string $id): void
    {
        foreach ($plan['steps'] as &$step) {
            $step['plan_id'] = $id;
            $step['decode'] = [];
            if (isset($step['assemble'])) {
                self::indexNode($step['assemble']);
                self::decodeCells($step['assemble'], $step['decode']);
            }
        }
    }

    /** Collects the styled cells of a node and its joined nodes for Codec::decodeRows. */
    private static function decodeCells(array $a, array &$out): void
    {
        $version = null;
        foreach ($a['columns'] as $c) {
            if (!empty($c['hidden']) && ($c['column'] ?? '') === 'aes_key_version') {
                $version = $c['index'];
                break;
            }
        }
        foreach ($a['columns'] as $c) {
            if (!empty($c['styles'])) {
                $out[] = [$c['index'], $c['host'], $c['codec'], in_array('aes', $c['host'], true), $version];
            }
        }
        foreach ($a['children'] ?? [] as $ch) {
            if ($ch['kind'] === 'join') {
                self::decodeCells($ch['assemble'], $out);
            }
        }
    }

    private static function indexNode(array &$a): void
    {
        $idx = [];
        $hidden = [];
        foreach ($a['columns'] as $i => $c) {
            $idx[$c['name']] = $c['index'];
            if (!empty($c['hidden'])) {
                $hidden[$c['name']] = true;
            }
            if (!empty($c['styles'])) {
                $host = [];
                $codec = [];
                foreach ($c['styles'] as $st) {
                    if (Codec::isHostStyle($st)) {
                        $host[] = $st;
                    } else {
                        $codec[] = $st;
                    }
                }
                $a['columns'][$i]['host'] = $host;
                $a['columns'][$i]['codec'] = $codec;
            }
        }
        $a['idx'] = $idx;
        $a['node'] = ++self::$nodes;
        $a['hidden'] = $hidden;
        if (isset($a['children'])) {
            foreach ($a['children'] as &$ch) {
                if (isset($ch['assemble'])) {
                    self::indexNode($ch['assemble']);
                }
            }
        }
    }
}
