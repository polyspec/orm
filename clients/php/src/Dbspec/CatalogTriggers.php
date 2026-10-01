<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * catalog trigger 를 renderer statement 형식으로 다시 쓴 것에서 immutable 과
 * audit setting 을 알아본다 (docs/dialects.md "Introspection", "Triggers").
 *
 * @internal
 */
final class CatalogTriggers
{
    private const AUDIT_INSERT = '/^INSERT INTO [`"]([a-z0-9_]+)[`"] \([`"]([a-z0-9_]+)[`"], [`"]([a-z0-9_]+)[`"],/';
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
                // audit 의 인자는 history table, operation, action, previous 순이다.
                $candidates[] = new Setting('audit', [$m[1], $u[1], $m[2], $m[3]]);
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
                [$history, $operation, $action, $previous] = $setting->arguments;
                return ["audit into $history operation $operation action $action previous $previous"];
            }
        }
        return null;
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
