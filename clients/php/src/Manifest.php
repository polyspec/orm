<?php
declare(strict_types=1);

namespace Orm;

/**
 * A generated schema manifest (schema.json). Entities are the decoded JSON
 * objects with a `colmap` index added; the schema hash is verified against the
 * content.
 */
final class Manifest
{
    /**
     * @param array<string, array> $entities
     * @param list<string> $order
     */
    private function __construct(
        public readonly string $schemaHash,
        public readonly array $order,
        public readonly array $entities,
        public readonly array $externalFks,
        public readonly array $immutable,
    ) {}

    public static function load(string $json): self
    {
        $m = json_decode($json, true);
        if (!is_array($m) || !is_string($m['schema_hash'] ?? null) || !is_array($m['entities'] ?? null)) {
            throw new OrmException(Code::SCHEMA_INVALID, 'schema.json is not a manifest');
        }
        $hash = self::hash($json);
        if ($hash !== $m['schema_hash']) {
            throw new OrmException(Code::SCHEMA_INVALID, "schema.json was edited by hand: hash {$m['schema_hash']} does not match content $hash");
        }
        $entities = [];
        foreach ($m['entities'] as $name => $e) {
            $e['colmap'] = [];
            foreach ($e['columns'] as $c) {
                $e['colmap'][$c['name']] = $c;
            }
            $e['relations'] ??= [];
            $entities[(string) $name] = $e;
        }
        return new self($m['schema_hash'], $m['order'] ?? [], $entities, $m['external_fks'] ?? [], $m['immutable'] ?? []);
    }

    public static function file(string $path): self
    {
        $json = @file_get_contents($path);
        if ($json === false) {
            throw new OrmException(Code::SCHEMA_INVALID, "cannot read $path");
        }
        return self::load($json);
    }

    /**
     * The manifest hash: SHA-256 of the compact JSON with an empty schema_hash,
     * first 8 bytes in hex. The generator writes indented canonical JSON, so
     * removing the whitespace outside strings restores the canonical bytes.
     */
    public static function hash(string $json): string
    {
        $out = '';
        $n = strlen($json);
        $string = false;
        for ($i = 0; $i < $n; $i++) {
            $c = $json[$i];
            if ($string) {
                $out .= $c;
                if ($c === '\\') {
                    $out .= $json[++$i];
                } elseif ($c === '"') {
                    $string = false;
                }
                continue;
            }
            if ($c === ' ' || $c === "\n" || $c === "\r" || $c === "\t") {
                continue;
            }
            if ($c === '"') {
                $string = true;
            }
            $out .= $c;
        }
        $out = preg_replace('/^\{"schema_hash":"[^"]*"/', '{"schema_hash":""', $out, 1);
        return substr(hash('sha256', $out), 0, 16);
    }

    public function entity(string $name): ?array
    {
        return $this->entities[$name] ?? null;
    }

    public static function column(array $entity, string $name): ?array
    {
        return $entity['colmap'][$name] ?? null;
    }
}
