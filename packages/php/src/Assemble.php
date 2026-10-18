<?php
declare(strict_types=1);

namespace Polyspec\Orm;

final class Assemble
{
    private static int $nodes = 0;

    /**
     * Stamps every step with 'decode' (the styled cells Codec::decodeRows converts) and adds
     * 'idx' => [name => position] and a process-unique 'node' number to every assemble node in
     * place. A styled column's stages are
     * split once into 'host' (aes/hex/ip, the stages the dialect left to the executor) and 'codec'
     * (docs/codec.md), in write order.
     */
    public static function index(array &$plan, RuntimeModel $model): void
    {
        foreach ($plan['steps'] as &$step) {
            $step['decode'] = [];
            if (isset($step['assemble'])) {
                self::indexNode($step['assemble']);
                self::decodeCells($step['assemble'], $step['decode'], $model);
            }
        }
    }

    /** Collects the styled cells of a node and its joined nodes for Codec::decodeRows. */
    private static function decodeCells(array $a, array &$out, RuntimeModel $model): void
    {
        array_push($out, ...self::cells($a, $model));
        foreach ($a['children'] ?? [] as $ch) {
            if ($ch['kind'] === 'join') {
                self::decodeCells($ch['assemble'], $out, $model);
            }
        }
    }

    /**
     * The styled cells of one indexed node, without its joined nodes, for Codec::decodeRows. The
     * markdown executor answers each node in rows of its own and decodes them node by node.
     */
    public static function cells(array $a, RuntimeModel $model): array
    {
        // A node that reads an AES column also reads the entity's aes_version column.
        $name = $model->entities[$a['entity']]['aes_version'];
        $version = null;
        foreach ($a['columns'] as $c) {
            if ($name !== '' && ($c['column'] ?? '') === $name) {
                $version = $c['index'];
                break;
            }
        }
        $out = [];
        foreach ($a['columns'] as $c) {
            if (!empty($c['styles'])) {
                $out[] = [$c['index'], $c['host'], $c['codec'], in_array('aes', $c['host'], true), $version];
            }
        }
        return $out;
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
