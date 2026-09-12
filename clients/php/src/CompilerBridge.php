<?php
declare(strict_types=1);

namespace Orm;

use Orm\Compiler\V1\Assemble as WireAssemble;
use Orm\Compiler\V1\Assignment;
use Orm\Compiler\V1\BindSlot;
use Orm\Compiler\V1\Child;
use Orm\Compiler\V1\ColumnReference;
use Orm\Compiler\V1\CompileRequest;
use Orm\Compiler\V1\Group;
use Orm\Compiler\V1\GroupExpression;
use Orm\Compiler\V1\IfParent;
use Orm\Compiler\V1\Item;
use Orm\Compiler\V1\Join;
use Orm\Compiler\V1\Limit;
use Orm\Compiler\V1\Navigation;
use Orm\Compiler\V1\Optimistic;
use Orm\Compiler\V1\Order;
use Orm\Compiler\V1\OutputColumn;
use Orm\Compiler\V1\ParentCondition;
use Orm\Compiler\V1\ParentReference;
use Orm\Compiler\V1\Plan;
use Orm\Compiler\V1\PlanStep;
use Orm\Compiler\V1\Predicate;
use Orm\Compiler\V1\Projection;
use Orm\Compiler\V1\QueryKind;
use Orm\Compiler\V1\QueryNode;
use Orm\Compiler\V1\Raw;
use Orm\Compiler\V1\Relation;

final class CompilerBridge
{
    /** @param array<string,mixed> $ir */
    public static function request(array $ir): CompileRequest
    {
        $kind = strtoupper((string) ($ir['kind'] ?? ''));
        $constant = QueryKind::class . '::QUERY_KIND_' . $kind;
        return new CompileRequest([
            'ir_version' => self::uint($ir['ir_version'] ?? 0, 'ir_version'),
            'schema_hash' => (string) ($ir['schema_hash'] ?? ''),
            'kind' => defined($constant) ? constant($constant) : QueryKind::QUERY_KIND_UNSPECIFIED,
            'root' => self::query($ir, 'root'),
            'set' => self::assignments($ir['set'] ?? [], 'set'),
            'on_duplicate' => self::assignments($ir['on_duplicate'] ?? [], 'on_duplicate'),
            'optimistic' => isset($ir['optimistic']) ? new Optimistic(['column' => (string) $ir['optimistic']['column'], 'parameter' => self::uint($ir['optimistic']['p'], 'optimistic.parameter')]) : null,
            'raw' => isset($ir['raw']) ? new Raw(['sql' => (string) $ir['raw']['sql'], 'parameters' => self::uints($ir['raw']['ps'] ?? [], 'raw.parameters')]) : null,
            'parameter_count' => self::uint($ir['n_params'] ?? 0, 'parameter_count'),
            'aggregate' => (string) ($ir['agg'] ?? ''),
            'debug' => (bool) ($ir['debug'] ?? false),
        ]);
    }

    /** @param array<string,mixed> $q */
    private static function query(array $q, string $path): QueryNode
    {
        $data = [
            'entity' => (string) ($q['entity'] ?? ''),
            'joins' => array_map(fn(array $v, int $i) => new Join(['relation' => (string) $v['rel'], 'kind' => (string) $v['kind'], 'query' => self::query($v['query'], "$path.joins[$i].query")]), $q['joins'] ?? [], array_keys($q['joins'] ?? [])),
            'relations' => array_map(fn(array $v, int $i) => new Relation(['relation' => (string) $v['rel'], 'query' => self::query($v['query'], "$path.relations[$i].query")]), $q['relations'] ?? [], array_keys($q['relations'] ?? [])),
            'order' => array_map(fn(array $v) => new Order(['column' => (string) ($v['column'] ?? ''), 'expression' => (string) ($v['expr'] ?? ''), 'descending' => (bool) ($v['desc'] ?? false)]), $q['order'] ?? []),
            'group_by' => $q['group_by'] ?? [],
            'group_by_expression' => array_map(fn(array $v) => new GroupExpression(['expression' => (string) $v['expr'], 'alias' => (string) $v['as']]), $q['group_by_expr'] ?? []),
            'distinct' => (bool) ($q['distinct'] ?? false), 'force_index' => (string) ($q['force_index'] ?? ''),
            'key_by' => (string) ($q['key_by'] ?? ''), 'flatten' => (bool) ($q['flatten'] ?? false),
            'limit_per_parent' => self::uint($q['limit_per_parent'] ?? 0, "$path.limit_per_parent"),
            'drop_child_key' => (bool) ($q['drop_child_key'] ?? false), 'no_cascade_delete' => (bool) ($q['no_cascade_delete'] ?? false),
        ];
        if (isset($q['columns'])) {
            $modes = ['' => 0, 'all' => 1, 'none' => 2];
            $mode = (string) ($q['columns']['mode'] ?? '');
            if (!array_key_exists($mode, $modes)) throw new OrmException(Code::IR_INVALID, "$path.columns.mode is invalid");
            $data['columns'] = new Projection(['mode' => $modes[$mode], 'add' => $q['columns']['add'] ?? [], 'remove' => $q['columns']['remove'] ?? [], 'aliases' => $q['columns']['as'] ?? [], 'expressions' => $q['columns']['expr'] ?? []]);
        }
        foreach (['on', 'where', 'having'] as $name) if (isset($q[$name])) $data[$name] = self::group($q[$name], "$path.$name");
        if (isset($q['limit'])) $data['limit'] = new Limit(['offset' => self::uint($q['limit']['offset'], "$path.limit.offset"), 'count' => self::uint($q['limit']['count'], "$path.limit.count")]);
        if (isset($q['if_parent'])) $data['if_parent'] = new IfParent(['column' => (string) $q['if_parent']['column'], 'parameter' => self::uint($q['if_parent']['p'], "$path.if_parent.parameter")]);
        if (array_key_exists('scope_p', $q)) $data['scope_parameter'] = self::uint($q['scope_p'], "$path.scope_parameter");
        return new QueryNode($data);
    }

    /** @param array<string,mixed> $g */
    private static function group(array $g, string $path): Group
    {
        $items = [];
        foreach ($g['items'] ?? [] as $i => $value) {
            if (isset($value['pred'])) {
                $p = $value['pred'];
                $data = ['connector' => (string) ($p['conn'] ?? ''), 'column' => (string) ($p['column'] ?? ''), 'operator' => (string) ($p['op'] ?? ''), 'parameters' => self::uints($p['ps'] ?? [], "$path.items[$i].predicate.parameters"), 'expression' => (string) ($p['expr'] ?? ''), 'match_columns' => $p['match'] ?? []];
                if (array_key_exists('p', $p)) $data['parameter'] = self::uint($p['p'], "$path.items[$i].predicate.parameter");
                if (isset($p['ref'])) $data['reference'] = new ColumnReference(['path' => (string) $p['ref']['path'], 'column' => (string) $p['ref']['column']]);
                $items[] = new Item(['predicate' => new Predicate($data)]);
            } elseif (isset($value['group'])) {
                $items[] = new Item(['group' => self::group($value['group'], "$path.items[$i].group")]);
            } elseif (isset($value['nav'])) {
                $n = $value['nav'];
                $items[] = new Item(['navigation' => new Navigation(['connector' => (string) ($n['conn'] ?? ''), 'relation' => (string) $n['rel'], 'group' => self::group($n['group'], "$path.items[$i].navigation.group")])]);
            } else throw new OrmException(Code::IR_INVALID, "$path.items[$i] must contain exactly one value");
        }
        return new Group(['connector' => (string) ($g['conn'] ?? ''), 'items' => $items]);
    }

    /** @param list<array<string,mixed>> $values @return list<Assignment> */
    private static function assignments(array $values, string $path): array
    {
        return array_map(function(array $v, int $i) use ($path): Assignment {
            $data = ['column' => (string) $v['column'], 'set_null' => (bool) ($v['null'] ?? false), 'expression' => (string) ($v['expr'] ?? ''), 'expression_parameters' => self::uints($v['ps'] ?? [], "{$path}[{$i}].expression_parameters")];
            foreach (['p' => 'parameter', 'plus_p' => 'plus_parameter', 'minus_p' => 'minus_parameter'] as $from => $to) if (array_key_exists($from, $v)) $data[$to] = self::uint($v[$from], "{$path}[{$i}].{$to}");
            return new Assignment($data);
        }, $values, array_keys($values));
    }

    /** @return array<string,mixed> */
    public static function plan(Plan $plan): array
    {
        $kinds = [1=>'one',2=>'all',3=>'count',4=>'group_count',5=>'count_distinct',6=>'sum',7=>'avg',8=>'min',9=>'max',10=>'paginate',11=>'insert',12=>'update',13=>'delete',14=>'raw'];
        $kind = $kinds[$plan->getKind()] ?? throw new OrmException(Code::INTERNAL, 'compiler returned an unknown query kind');
        return ['schema_hash' => $plan->getSchemaHash(), 'kind' => $kind, 'steps' => array_map(self::step(...), iterator_to_array($plan->getSteps()))];
    }

    /** @return array<string,mixed> */
    private static function step(PlanStep $step): array
    {
        $out = ['id'=>$step->getId(), 'role'=>$step->getRole(), 'sql'=>$step->getSql(), 'bind_slots'=>array_map(fn(BindSlot $v) => ['from'=>$v->getSource(),'param'=>$v->getParameter(),'transform'=>$v->getTransform(),'name'=>$v->getName(),'step'=>$v->getStep(),'column'=>$v->getColumn(),'host_styles'=>iterator_to_array($v->getHostStyles()),'col_type'=>$v->getColumnType()], iterator_to_array($step->getBinds()))];
        if ($step->hasAssemble()) $out['assemble'] = self::assemble($step->getAssemble());
        if ($step->hasParent()) {
            $p=$step->getParent(); $out['parent']=['step'=>$p->getStep(),'keys'=>self::keys($p->getKeys())];
            if ($p->hasIfParent()) { $v=$p->getIfParent(); $out['parent']['if_parent']=['column'=>$v->getColumn(),'index'=>$v->getIndex(),'param'=>$v->getParameter()]; }
        }
        return $out;
    }

    /** @return array<string,mixed> */
    private static function assemble(WireAssemble $a): array
    {
        return ['entity'=>$a->getEntity(),'alias'=>$a->getAlias(),'columns'=>array_map(fn(OutputColumn $v)=>['index'=>$v->getIndex(),'name'=>$v->getName(),'column'=>$v->getColumn(),'type'=>$v->getType(),'styles'=>iterator_to_array($v->getStyles()),'hidden'=>$v->getHidden()],iterator_to_array($a->getColumns())),'children'=>array_map(function(Child $v){$out=['rel'=>$v->getRelation(),'kind'=>$v->getKind(),'step'=>$v->getStep(),'parent_keys'=>self::keys($v->getParentKeys()),'child_keys'=>self::keys($v->getChildKeys()),'key'=>self::keys($v->getKey()),'flatten'=>$v->getFlatten(),'cascade'=>$v->getCascade()];if($v->hasAssemble())$out['assemble']=self::assemble($v->getAssemble());return $out;},iterator_to_array($a->getChildren()))];
    }

    /** @return list<array{column:string,index:int}> */
    private static function keys(iterable $values): array { $out=[]; foreach($values as $v)$out[]=['column'=>$v->getColumn(),'index'=>$v->getIndex()]; return $out; }

    private static function uint(mixed $value, string $path): int { if (!is_int($value) || $value < 0 || $value > 0xffffffff) throw new OrmException(Code::IR_INVALID, "$path is outside uint32"); return $value; }
    /** @param list<mixed> $values @return list<int> */
    private static function uints(array $values, string $path): array { return array_map(fn($v,$i)=>self::uint($v,"{$path}[{$i}]"),$values,array_keys($values)); }
}
