<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * Orders plans into one chain from the empty database (docs/plans.md "Chain").
 *
 * @internal
 */
final class PlanChain
{
    /** @param list<Plan> $plans */
    public static function chain(array $plans): ChainResult
    {
        // plan이 없으면 table이 없는 database의 빈 chain이다.
        if ($plans === []) {
            return ChainResult::valid([]);
        }
        // from 이 없는 plan 은 '' 에 모은다; schemaHash 는 비어 있지 않다.
        $byFrom = [];
        foreach ($plans as $plan) {
            $byFrom[$plan->from ?? ''][] = $plan;
        }
        $froms = array_map('strval', array_keys($byFrom));
        usort($froms, strcmp(...));
        $diagnostics = [];
        foreach ($froms as $from) {
            if (count($byFrom[$from]) > 1) {
                $names = array_map(static fn(Plan $p): string => $p->name, $byFrom[$from]);
                usort($names, strcmp(...));
                $diagnostics[] = self::diagnostic('plans ' . implode(', ', $names) . ' start from the same schema');
            }
        }
        if (!isset($byFrom[''])) {
            $diagnostics[] = self::diagnostic('no plan starts from empty');
        }
        if ($diagnostics !== []) {
            return ChainResult::invalid($diagnostics);
        }
        $chain = [];
        $visited = [];
        for ($plan = $byFrom[''][0]; $plan !== null;) {
            $id = spl_object_id($plan);
            if (isset($visited[$id])) {
                return ChainResult::invalid([self::diagnostic("plan {$plan->name} closes a cycle")]);
            }
            $visited[$id] = true;
            $chain[] = $plan;
            $plan = $byFrom[$plan->to][0] ?? null;
        }
        $unreached = [];
        foreach ($plans as $plan) {
            if (!isset($visited[spl_object_id($plan)])) {
                $unreached[] = $plan->name;
            }
        }
        if ($unreached !== []) {
            usort($unreached, strcmp(...));
            return ChainResult::invalid([self::diagnostic('no chain reaches plans ' . implode(', ', $unreached))]);
        }
        return ChainResult::valid($chain);
    }

    private static function diagnostic(string $message): Diagnostic
    {
        return new Diagnostic('chain', 1, 1, $message);
    }
}
