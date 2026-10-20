<?php

declare(strict_types=1);

namespace Polyspec\Orm;

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Document;

/**
 * The runtime model of a dbspec document set (docs/spec/dbspec.md "Runtime model").
 * One entity per table; documents are in name order, and tables are in document order.
 * The generator writes each entity as the model class's meta() array, and the engine
 * rereads the same array from the registered model, so no request parses dbspec text.
 *
 * Each entity is [entity, table, pk, identity, updated, soft_delete, aes_version,
 * audit, audit_record, columns, unique, indexes], and `audit` is the audit
 * column, and `audit_record` names the table that holds the transaction's audit records. Each column is [name, type, nullable, default, default_now, select,
 * codec, blind_index, pk, foreign_key], and decimal, time, and datetime have
 * precision, decimal also has scale, and varchar has length. default_now means the default is `now`.
 * The generated model's meta() adds the manifest_hash of the document set that made the model to the entity.
 * manifest_hash.
 */
final class RuntimeModel
{
    /** The codec stage that makes a column value a StyledValue. aes, hex, and ip keep the value a string. */
    public const STYLED_STAGES = ['ordered_json', 'serialize', 'yaml', 'gz', 'base64'];
    /** The codec stage that a dialect or executor applies around a bind value. */
    public const HOST_STAGES = ['aes', 'hex', 'ip'];

    /**
     * @param array<string, array> $entities entity name => entity
     * @param string $externalText The text (Dbspec Manifest) of the tables that the owned documents use from external documents; a set
     *     with no external documents has empty text. A used table of an external document is an external entity.
     */
    public function __construct(
        public readonly string $manifestHash,
        public readonly string $manifestText,
        public readonly array $entities,
        public readonly string $externalText = '',
    ) {
    }

    /**
     * Parses the document set. Each text takes the rest of the texts, found by header name,
     * as the declared set to parse with. $texts is the map from the label that diagnostics point at (such as a file
     * path) to the text. If there is a diagnostic, it fails with SCHEMA_INVALID.
     *
     * @param array<string, string> $texts
     * @return list<Document>
     */
    public static function parse(array $texts): array
    {
        return self::parseSet($texts, []);
    }

    /**
     * The document set of the owned documents and external documents (the documents of other sets that owned documents use by use)
     * Parses all documents, each using all the other documents as the declared set; external documents are
     * marked external. External documents are parsed and checked, but not rendered, installed, compared, or generated.
     * Both maps are maps from label to text. If there is a diagnostic, it fails with SCHEMA_INVALID.
     *
     * @param array<string, string> $owned
     * @param array<string, string> $external
     * @return list<Document>
     */
    public static function parseSet(array $owned, array $external): array
    {
        $labels = [...array_keys($owned), ...array_keys($external)];
        $documents = [];
        $errors = [];
        foreach (Dbspec::parseSet(array_values($owned), array_values($external)) as $i => $result) {
            foreach ($result->diagnostics as $d) {
                $errors[] = "{$labels[$i]}:{$d->line}:{$d->column}: {$d->rule}: {$d->message}";
            }
            if ($result->document !== null) {
                $documents[] = $result->document;
            }
        }
        if ($errors !== []) {
            throw new OrmException(Code::SCHEMA_INVALID, implode("\n", $errors));
        }
        return $documents;
    }

    /**
     * Parses the generated schema's manifest text and external text (the tables used from external documents)
     * as a document set. A document in the external text is marked external.
     *
     * @return list<Document>
     */
    public static function loadSet(string $manifestText, string $externalText): array
    {
        $external = $externalText === '' ? [] : array_combine(
            array_map(static fn(string $label): string => "external $label", array_keys(self::splitManifest($externalText))),
            self::splitManifest($externalText),
        );
        return self::parseSet(self::splitManifest($manifestText), $external);
    }

    /**
     * The document text split from the manifest text at header lines. Each document's name is
     * its label. Text that does not start with a header is SCHEMA_INVALID.
     *
     * @return array<string, string>
     */
    public static function splitManifest(string $text): array
    {
        if (!str_starts_with($text, 'dbspec 1 ')) {
            throw new OrmException(Code::SCHEMA_INVALID, 'manifest text does not start with a dbspec header');
        }
        $out = [];
        foreach (preg_split('/(?<=\n)(?=dbspec 1 )/', $text) as $document) {
            $out['document ' . count($out)] = $document;
        }
        return $out;
    }

    /**
     * Reads the set file at $path with Dbspec::readSet, gives each listed file's bytes to
     * Dbspec::readBytes with its joined path and parses the set (parseSet). An error of the set file is
     * CONFIG with every error, one `<rule>: <message>` line each; a file with a diagnostic is
     * SCHEMA_INVALID with every diagnostic of every file.
     *
     * @return list<Document>
     */
    public static function set(string $path): array
    {
        $set = Dbspec::readSet($path);
        if ($set->errors !== []) {
            throw new OrmException(Code::CONFIG, implode("\n", array_map(static fn($e): string => "{$e->rule}: {$e->message}", $set->errors)));
        }
        $errors = [];
        $texts = ['documents' => [], 'external' => []];
        foreach (['documents' => $set->documents, 'external' => $set->external] as $list => $files) {
            foreach ($files as $file) {
                $read = Dbspec::readBytes($file->path, $file->bytes);
                foreach ($read->diagnostics as $d) {
                    $errors[] = "{$file->path}:{$d->line}:{$d->column}: {$d->rule}: {$d->message}";
                }
                if ($read->text !== null) {
                    $texts[$list][$file->path] = $read->text;
                }
            }
        }
        if ($errors !== []) {
            throw new OrmException(Code::SCHEMA_INVALID, implode("\n", $errors));
        }
        return self::parseSet($texts['documents'], $texts['external']);
    }

    /**
     * Reads the set's dbspec file with Dbspec::readFile and parses it. $external is an external document file that an owned document
     * uses by use (parseSet). An unreadable file is CONFIG; a file with no
     * signature fails with SCHEMA_INVALID.
     *
     * @param list<string> $paths
     * @param list<string> $external
     * @return list<Document>
     */
    public static function files(array $paths, array $external = []): array
    {
        if ($paths === []) {
            throw new OrmException(Code::CONFIG, 'a document set needs at least one dbspec file');
        }
        $read = static function (array $paths): array {
            $texts = [];
            $errors = [];
            foreach ($paths as $path) {
                try {
                    $read = Dbspec::readFile($path);
                } catch (\RuntimeException $e) {
                    throw new OrmException(Code::CONFIG, $e->getMessage(), $e);
                }
                foreach ($read->diagnostics as $d) {
                    $errors[] = "$path:{$d->line}:{$d->column}: {$d->rule}: {$d->message}";
                }
                if ($read->text !== null) {
                    $texts[$path] = $read->text;
                }
            }
            if ($errors !== []) {
                throw new OrmException(Code::SCHEMA_INVALID, implode("\n", $errors));
            }
            return $texts;
        };
        return self::parseSet($read($paths), $read($external));
    }

    /** Makes the runtime model of a parsed document set. @param list<Document> $documents */
    public static function build(array $documents): self
    {
        $result = Dbspec::manifest($documents);
        if ($result->manifest === null) {
            $lines = array_map(static fn($d): string => "{$d->line}:{$d->column}: {$d->rule}: {$d->message}", $result->diagnostics);
            throw new OrmException(Code::SCHEMA_INVALID, implode("\n", $lines));
        }
        usort($documents, static fn(Document $a, Document $b): int => strcmp($a->name, $b->name));
        // The tables that owned documents use from each external document (docs/spec/dbspec.md "External documents").
        $used = [];
        foreach ($documents as $document) {
            if (!$document->external) {
                foreach ($document->uses as $use) {
                    $used[$use->document] = [...($used[$use->document] ?? []), ...$use->tables];
                }
            }
        }
        $entities = [];
        foreach ($documents as $document) {
            foreach ($document->tables as $table) {
                if ($document->external) {
                    if (!in_array($table->name, $used[$document->name] ?? [], true)) {
                        continue;
                    }
                    $entity = self::externalEntity($table);
                } else {
                    $entity = self::tableEntity($table);
                }
                if (isset($entities[$entity['entity']])) {
                    throw new OrmException(Code::SCHEMA_INVALID, "entity {$entity['entity']} is declared twice in the document set");
                }
                $entities[$entity['entity']] = $entity;
            }
        }
        return new self($result->manifest->manifestHash, $result->manifest->manifestText, $entities, $result->manifest->externalText);
    }

    /**
     * The model of registered generated classes. Each class's meta() must equal the entity that the manifest text gives
     * (docs/spec/dbspec.md "Runtime model"): a class generated by another orm-gen, or edited, fails with CONFIG naming the
     * class, the entity, the first differing field path and the regeneration command, before any statement.
     * @param list<class-string<Model>> $classes
     */
    public static function fromModels(string $manifestHash, string $manifestText, array $classes, string $externalText = ''): self
    {
        $manifest = self::build(self::loadSet($manifestText, $externalText))->entities;
        $entities = [];
        foreach ($classes as $class) {
            $meta = $class::meta();
            // manifest_hash points at the document set that the model class belongs to, and is not part of an entity.
            unset($meta['manifest_hash']);
            $name = $meta['entity'] ?? null;
            $want = is_string($name) ? ($manifest[$name] ?? null) : null;
            $path = $want === null ? 'entity' : self::firstDifference($meta, $want, '');
            if ($path !== null) {
                $entity = is_string($name) ? $name : '?';
                throw new OrmException(Code::CONFIG, "generated model $class of entity $entity differs from its manifest at $path: "
                    . 'generate the models again (orm-gen gen --set <dbspec-set.json> --out <dir> --namespace <namespace>)');
            }
            $entities[$name] = $meta;
        }
        return new self($manifestHash, $manifestText, $entities, $externalText);
    }

    /** The first path where two metadata values differ, in the order of the expected keys and then the extra ones; null when equal. */
    private static function firstDifference(mixed $got, mixed $want, string $path): ?string
    {
        $here = $path === '' ? '(entity)' : $path;
        if (!is_array($got) || !is_array($want)) {
            return $got === $want ? null : $here;
        }
        foreach ($want as $key => $value) {
            $at = $path === '' ? (string) $key : "$path.$key";
            if (!array_key_exists($key, $got)) {
                return $at;
            }
            $found = self::firstDifference($got[$key], $value, $at);
            if ($found !== null) {
                return $found;
            }
        }
        foreach (array_keys($got) as $key) {
            if (!array_key_exists($key, $want)) {
                return $path === '' ? (string) $key : "$path.$key";
            }
        }
        // The same keys in another order are another array to the runtime, which compares entities with ===.
        return $got === $want ? null : $here;
    }

    public function entity(string $name): ?array
    {
        return $this->entities[$name] ?? null;
    }

    public static function column(array $entity, string $name): ?array
    {
        return $entity['columns'][$name] ?? null;
    }

    /** Whether the column value is a StyledValue. */
    public static function styled(array $column): bool
    {
        return array_intersect($column['codec'], self::STYLED_STAGES) !== [];
    }

    /** Whether the column is encrypted by the aes stage. */
    public static function encrypted(array $column): bool
    {
        return in_array('aes', $column['codec'], true);
    }

    /** Whether the type is an integer, real, or decimal type that plus, minus, sum, and avg accept. */
    public static function numeric(array $column): bool
    {
        return $column['codec'] === [] && in_array($column['type'], ['i16', 'i32', 'i64', 'f64', 'decimal'], true);
    }

    /**
     * The external entity of a used table of an external document: the table reduced to its columns, primary key
     * and unique keys, as the external text holds it, so a model built from the documents equals one built from
     * that text. Every write of it fails with CONFIG (docs/spec/dbspec.md "External documents").
     */
    private static function externalEntity(\Polyspec\Orm\Dbspec\Table $table): array
    {
        $reduced = new \Polyspec\Orm\Dbspec\Table($table->name);
        $reduced->columns = $table->columns;
        $reduced->primaryKey = $table->primaryKey;
        $reduced->uniqueKeys = $table->uniqueKeys;
        return self::tableEntity($reduced) + ['external' => true];
    }

    private static function tableEntity(\Polyspec\Orm\Dbspec\Table $table): array
    {
        $settings = [];
        foreach ($table->settings?->settings ?? [] as $s) {
            $settings[$s->kind][] = $s->arguments;
        }
        $one = static fn(string $kind): string => $settings[$kind][0][0] ?? '';
        $foreignKeys = [];
        foreach ($table->foreignKeys as $fk) {
            foreach ($fk->columns as $c) {
                $foreignKeys[$c] = true;
            }
        }
        $codecs = [];
        foreach ($settings['codec'] ?? [] as $args) {
            $codecs[$args[0]] = array_slice($args, 1);
        }
        $blind = [];
        foreach ($settings['blind_index'] ?? [] as $args) {
            $blind[$args[0]] = $args[1];
        }
        $explicit = array_merge(...($settings['select_explicit'] ?? [[]]));
        $pk = $table->primaryKey->columns;
        $identity = '';
        $columns = [];
        foreach ($table->columns as $c) {
            if ($c->identity) {
                $identity = $c->name;
            }
            $column = [
                'name' => $c->name,
                'type' => $c->type->name,
                'nullable' => $c->nullable,
                'default' => $c->default !== null,
                'default_now' => $c->default === 'now',
                'select' => !in_array($c->name, $explicit, true),
                'codec' => $codecs[$c->name] ?? [],
                'blind_index' => $blind[$c->name] ?? '',
                'pk' => in_array($c->name, $pk, true),
                'foreign_key' => isset($foreignKeys[$c->name]),
            ];
            switch ($c->type->name) {
                case 'decimal':
                    $column['precision'] = $c->type->parameters[0];
                    $column['scale'] = $c->type->parameters[1];
                    break;
                case 'time':
                case 'datetime':
                    $column['precision'] = $c->type->parameters[0];
                    break;
                case 'varchar':
                    $column['length'] = $c->type->parameters[0];
                    break;
            }
            $columns[$c->name] = $column;
        }
        // The unique keys and indexes are in name order, the order of the canonical manifest text (Dbspec\Emitter), so a
        // model built from the documents equals the model of its manifest whatever order the documents declare them in.
        $unique = [];
        foreach ($table->uniqueKeys as $uk) {
            $unique[$uk->name] = $uk->columns;
        }
        uksort($unique, strcmp(...));
        $indexes = [];
        foreach ($table->indexes as $ix) {
            $indexes[$ix->name] = array_map(static fn($c): string => $c->name, $ix->columns);
        }
        uksort($indexes, strcmp(...));
        return [
            'entity' => $one('entity') !== '' ? $one('entity') : $table->name,
            'table' => $table->name,
            'pk' => $pk,
            'identity' => $identity,
            'updated' => $one('updated'),
            'soft_delete' => $one('soft_delete'),
            'aes_version' => $one('aes_version'),
            'audit' => $settings['audit'][0][1] ?? '',
            'audit_record' => $settings['audit'][0][2] ?? '',
            'columns' => $columns,
            'unique' => $unique,
            'indexes' => $indexes,
        ];
    }
}
