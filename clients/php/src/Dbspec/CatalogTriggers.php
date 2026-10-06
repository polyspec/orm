<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * catalog trigger 를 renderer statement 형식으로 다시 쓴 것에서 immutable 과
 * audit setting 을 알아본다 (docs/dialects.md "Introspection", "Triggers").
 *
 * @internal
 */
final class CatalogTriggers
{
    private const AUDIT_INSERT = '/^INSERT INTO [`"]([a-z0-9_]+)[`"] \(([^)]*)\) VALUES /';
    private const AUDIT_COLUMN = '/^[`"]([a-z0-9_]+)[`"]$/D';
    private const AUDIT_UPDATE = '/VALUES \(\'update\', OLD\.[`"]([a-z0-9_]+)[`"],/';

    /**
     * table 마다 trigger 집합이 immutable 이나 audit 의 renderer 출력과 같으면 그
     * setting 을 더하고, 아니면 모든 trigger 를 미지원으로 보고한다.
     *
     * @param array<string, list<array{name: string, statements: list<string>}>> $triggers table: trigger
     */
    public static function recognize(Catalog $c, string $dialect, array $triggers): void
    {
        ksort($triggers, SORT_STRING);
        foreach ($triggers as $table => $list) {
            $table = (string) $table;
            $t = $c->table($table);
            if ($t === null) {
                foreach ($list as $tr) {
                    $c->report('trigger', $table, $tr['name'], 'the table is not read');
                }
                continue;
            }
            $settings = self::setting($dialect, $t, $list);
            if ($settings === null) {
                foreach ($list as $tr) {
                    $c->report('trigger', $table, $tr['name'], 'the trigger is not the renderer output of immutable or audit');
                }
                continue;
            }
            array_push($t->settings, ...$settings);
        }
    }

    /**
     * trigger 집합이 같은 renderer 출력을 주는 setting 의 줄, 없으면 null.
     *
     * @param list<array{name: string, statements: list<string>}> $list
     * @return ?list<string>
     */
    private static function setting(string $dialect, CatalogTable $t, array $list): ?array
    {
        $names = [];
        foreach ($list as $tr) {
            $names[$tr['name']] = $tr;
        }
        $model = new Table($t->name);
        foreach ($t->columns as $column) {
            $model->columns[] = new Column($column['name'], $column['type'], false, false, null);
        }
        $candidates = [];
        if (count($list) === 2) {
            $candidates[] = new Setting('immutable', []);
        }
        $insert = $names[$t->name . '$audit_insert'] ?? null;
        if ($insert !== null && count($list) === 3) {
            $update = $names[$t->name . '$audit_update'] ?? null;
            if (preg_match(self::AUDIT_INSERT, self::body($insert['statements']), $m)
                && preg_match(self::AUDIT_UPDATE, self::body($update['statements'] ?? []), $u)) {
                $audit = self::audit($t, $m[1], explode(', ', $m[2]), $u[1]);
                if ($audit !== null) {
                    $candidates[] = $audit;
                }
            }
        }
        foreach ($candidates as $setting) {
            $model->settings = new Settings();
            $model->settings->settings = [$setting];
            $want = Renderer::tableTriggers($model, $dialect);
            $got = [];
            foreach (self::order($want) as $name) {
                if (!isset($names[$name])) {
                    $got = [];
                    break;
                }
                array_push($got, ...$names[$name]['statements']);
            }
            if ($got === $want) {
                if ($setting->kind === 'immutable') {
                    return ['immutable'];
                }
                return [$setting->auditLine('exclude', $setting->exclude)];
            }
        }
        return null;
    }

    /**
     * audit insert trigger의 column 목록(action, previous, 기록하는 column)과 update trigger의
     * audit column으로 audit setting을 만든다. audit 기록 table은 audit column 하나만 가진 table의
     * foreign key가 가리키는 table이다. 기록하지 않는 column은 table의 column 순서로 exclude
     * 목록이 된다. 목록이 renderer 형식이 아니거나, audit column을 기록하지 않거나, 그 foreign
     * key가 하나가 아니면 null이다. 만든 setting은 다시 렌더링해 catalog trigger와 비교한다.
     *
     * @param list<string> $quoted
     */
    private static function audit(CatalogTable $t, string $history, array $quoted, string $column): ?Setting
    {
        $names = [];
        foreach ($quoted as $q) {
            if (preg_match(self::AUDIT_COLUMN, $q, $m) !== 1) {
                return null;
            }
            $names[] = $m[1];
        }
        $recorded = array_slice($names, 2);
        if ($recorded === [] || !in_array($column, $recorded, true)) {
            return null;
        }
        $references = '';
        foreach ($t->foreignKeys as $f) {
            if ($f['columns'] === [$column]) {
                if ($references !== '') {
                    return null;
                }
                $references = $f['table'];
            }
        }
        if ($references === '') {
            return null;
        }
        $excluded = [];
        foreach ($t->columns as $c) {
            if (!in_array($c['name'], $recorded, true)) {
                $excluded[] = $c['name'];
            }
        }
        // audit 의 인자는 history table, audit column, audit 기록 table, action, previous 순이다.
        return new Setting('audit', [$history, $column, $references, $names[0], $names[1]], [], $excluded === [] ? null : $excluded);
    }

    /**
     * renderer statement 목록에서 trigger 이름을 순서대로 꺼낸다.
     *
     * @param list<string> $statements
     * @return list<string>
     */
    private static function order(array $statements): array
    {
        $names = [];
        foreach ($statements as $s) {
            if (!str_starts_with($s, 'CREATE TRIGGER ')) {
                continue;
            }
            $rest = substr($s, strlen('CREATE TRIGGER '));
            $end = strpos($rest, $rest[0], 1);
            $names[] = substr($rest, 1, $end - 1);
        }
        return $names;
    }

    /**
     * trigger statement 에서 본문을 꺼낸다: MySQL 은 FOR EACH ROW 뒤, PostgreSQL 은
     * function 의 BEGIN 뒤, SQLite 는 BEGIN 뒤다.
     *
     * @param list<string> $statements
     */
    private static function body(array $statements): string
    {
        foreach ($statements as $s) {
            foreach (['$$BEGIN ', 'FOR EACH ROW BEGIN ', 'FOR EACH ROW '] as $marker) {
                $i = strpos($s, $marker);
                if ($i !== false) {
                    return substr($s, $i + strlen($marker));
                }
            }
        }
        return '';
    }
}
