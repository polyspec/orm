<?php
declare(strict_types=1);

namespace Orm;

use Orm\Dbspec\Dbspec;
use Orm\Dbspec\Document;

/**
 * dbspec document set의 runtime model이다(docs/dbspec.md "Runtime model").
 * table마다 entity 하나를 두며, 문서는 이름 순서, table은 문서 순서다.
 * generator는 각 entity를 model class의 meta() 배열로 쓰고, engine은 등록된
 * model에서 같은 배열을 다시 읽으므로 어떤 요청도 dbspec text를 parse하지 않는다.
 *
 * entity는 [entity, table, pk, identity, updated, soft_delete, aes_version,
 * audit, audit_record, columns, unique, indexes]이며 `audit`은 감사 table의 audit
 * column, `audit_record`는 transaction의 audit 기록을 담는 table의 entity 이름이다. column은 [name, type, nullable, default, default_now, select,
 * codec, blind_index, pk, foreign_key]이고 decimal, time, datetime은
 * precision을, decimal은 scale도 가진다. default_now는 default가 `now`임을
 * 뜻한다. generated model의 meta()는 entity에 그 model을 만든 document set의
 * manifest_hash를 더한다.
 */
final class RuntimeModel
{
    /** column 값을 StyledValue로 만드는 codec stage다. aes, hex, ip는 string을 유지한다. */
    public const STYLED_STAGES = ['ordered_json', 'serialize', 'yaml', 'gz', 'base64'];
    /** dialect나 executor가 bind 값 주위에 적용하는 codec stage다. */
    public const HOST_STAGES = ['aes', 'hex', 'ip'];

    /** @param array<string, array> $entities entity name => entity */
    public function __construct(
        public readonly string $manifestHash,
        public readonly string $manifestText,
        public readonly array $entities,
    ) {}

    /**
     * document set을 parse한다. 각 text는 header 이름으로 찾는 나머지 text를
     * 선언된 집합으로 삼아 parse한다. $texts는 diagnostic이 가리키는 label(파일
     * 경로 등)에서 text로의 map이다. diagnostic이 있으면 SCHEMA_INVALID로 실패한다.
     *
     * @param array<string, string> $texts
     * @return list<Document>
     */
    public static function parse(array $texts): array
    {
        $named = [];
        foreach ($texts as $label => $text) {
            if (preg_match('/\Adbspec 1 ([a-z][a-z0-9_]*)(?:\r?\n|\z)/', $text, $m) === 1) {
                $named[$m[1]] = $text;
            }
        }
        $documents = [];
        $errors = [];
        foreach ($texts as $label => $text) {
            $result = Dbspec::parse($text, $named);
            foreach ($result->diagnostics as $d) {
                $errors[] = "$label:{$d->line}:{$d->column}: {$d->rule}: {$d->message}";
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
     * manifest text를 header 줄에서 나눈 document text다. 각 document의 이름을
     * label로 갖는다. header로 시작하지 않는 text는 SCHEMA_INVALID다.
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
     * document set의 dbspec 파일을 Dbspec::readFile로 읽어 parse한다. 읽을 수 없는 파일은
     * CONFIG, signature가 없는 파일은 SCHEMA_INVALID로 실패한다. @param list<string> $paths
     */
    public static function files(array $paths): array
    {
        if ($paths === []) {
            throw new OrmException(Code::CONFIG, 'a document set needs at least one dbspec file');
        }
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
        return self::parse($texts);
    }

    /** parse된 document set의 runtime model을 만든다. @param list<Document> $documents */
    public static function build(array $documents): self
    {
        $result = Dbspec::manifest($documents);
        if ($result->manifest === null) {
            $lines = array_map(static fn($d): string => "{$d->line}:{$d->column}: {$d->rule}: {$d->message}", $result->diagnostics);
            throw new OrmException(Code::SCHEMA_INVALID, implode("\n", $lines));
        }
        usort($documents, static fn(Document $a, Document $b): int => strcmp($a->name, $b->name));
        $entities = [];
        foreach ($documents as $document) {
            foreach ($document->tables as $table) {
                $entity = self::tableEntity($table);
                if (isset($entities[$entity['entity']])) {
                    throw new OrmException(Code::SCHEMA_INVALID, "entity {$entity['entity']} is declared twice in the document set");
                }
                $entities[$entity['entity']] = $entity;
            }
        }
        $byTable = [];
        foreach ($entities as $name => $entity) {
            $byTable[$entity['table']] = $name;
        }
        foreach ($entities as $name => $entity) {
            if ($entity['audit_record'] !== '') {
                $entities[$name]['audit_record'] = $byTable[$entity['audit_record']] ?? $entity['audit_record'];
            }
        }
        return new self($result->manifest->manifestHash, $result->manifest->manifestText, $entities);
    }

    /** 등록된 generated class의 model이다. @param list<class-string<Model>> $classes */
    public static function fromModels(string $manifestHash, string $manifestText, array $classes): self
    {
        $entities = [];
        foreach ($classes as $class) {
            $meta = $class::meta();
            // manifest_hash는 model class가 속한 document set을 가리키며 entity의 일부가 아니다.
            unset($meta['manifest_hash']);
            $entities[$meta['entity']] = $meta;
        }
        return new self($manifestHash, $manifestText, $entities);
    }

    public function entity(string $name): ?array
    {
        return $this->entities[$name] ?? null;
    }

    public static function column(array $entity, string $name): ?array
    {
        return $entity['columns'][$name] ?? null;
    }

    /** column 값이 StyledValue인지 여부다. */
    public static function styled(array $column): bool
    {
        return array_intersect($column['codec'], self::STYLED_STAGES) !== [];
    }

    /** column이 aes stage로 암호화되는지 여부다. */
    public static function encrypted(array $column): bool
    {
        return in_array('aes', $column['codec'], true);
    }

    /** plus, minus, sum, avg가 받는 정수, 실수, decimal type인지 여부다. */
    public static function numeric(array $column): bool
    {
        return $column['codec'] === [] && in_array($column['type'], ['i16', 'i32', 'i64', 'f64', 'decimal'], true);
    }

    private static function tableEntity(\Orm\Dbspec\Table $table): array
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
            }
            $columns[$c->name] = $column;
        }
        $unique = [];
        foreach ($table->uniqueKeys as $uk) {
            $unique[$uk->name] = $uk->columns;
        }
        $indexes = [];
        foreach ($table->indexes as $ix) {
            $indexes[$ix->name] = array_map(static fn($c): string => $c->name, $ix->columns);
        }
        return [
            'entity' => $one('entity') !== '' ? $one('entity') : $table->name,
            'table' => $table->name,
            'pk' => $pk,
            'identity' => $identity,
            'updated' => $one('updated'),
            'soft_delete' => $one('soft_delete'),
            'aes_version' => $one('aes_version'),
            'audit' => $settings['audit'][0][1] ?? '',
            // table 이름이며 build가 모든 entity를 만든 뒤 entity 이름으로 바꾼다.
            'audit_record' => $settings['audit'][0][2] ?? '',
            'columns' => $columns,
            'unique' => $unique,
            'indexes' => $indexes,
        ];
    }
}
