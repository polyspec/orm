<?php

declare(strict_types=1);

// The full-text predicates (PRT-75): the fulltext_boolean normalization of DIA-6, and the match each dialect renders over
// the columns, with SQLite refusing the predicate (DIA-187).
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/FulltextSearchTest.php

// The classes are read from this checkout's own sources, before the autoloader of the vendor folder, which a linked
// checkout would otherwise resolve to the sources of another checkout.
spl_autoload_register(static function (string $class): void {
    $prefix = 'Polyspec\\Orm\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $file = __DIR__ . '/../src/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    if (is_file($file)) {
        require $file;
    }
}, true, true);

use Polyspec\Orm\Code;
use Polyspec\Orm\Dialect;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Transform;
use PHPUnit\Framework\TestCase;

final class FulltextSearchTest extends TestCase
{
    public function test_fulltext_search(): void
    {
        $cases = [
            'alpha beta' => '+alpha +beta*',
            "  +a  (b) \"c\"  " => '+a +b +c*',
            'one ~ two' => '+one +two*',
            '' => '',
            "  \t " => '',
            '+ - < > ( ) ~ * " @' => '',
        ];
        foreach ($cases as $input => $want) {
            $this->assertSame($want, Transform::fulltextBoolean($input), "fulltextBoolean($input)");
        }

        $this->assertSame('+alpha +beta*', Transform::param('fulltext_boolean', 'alpha beta'));
        try {
            Transform::param('fulltext_boolean', '  ');
            $this->fail('an empty search text must be refused');
        } catch (OrmException $e) {
            $this->assertSame(Code::IR_INVALID, $e->code_);
        }

        $cols = ['p.name', 'p.description'];
        $value = static fn(string $t): string => "\$[$t]";
        $mysql = new Dialect('mysql');
        $postgres = new Dialect('postgres');
        $sqlite = new Dialect('sqlite');

        $this->assertSame(
            'MATCH (p.name, p.description) AGAINST ($[fulltext_boolean] IN BOOLEAN MODE)',
            $mysql->fulltext($cols, $value, true)
        );
        $this->assertSame(
            'MATCH (p.name, p.description) AGAINST ($[] IN NATURAL LANGUAGE MODE)',
            $mysql->fulltext($cols, $value, false)
        );
        $doc = "to_tsvector('simple', coalesce(p.name, '') || ' ' || coalesce(p.description, ''))";
        $this->assertSame("$doc @@ plainto_tsquery('simple', \$[])", $postgres->fulltext($cols, $value, false));
        $this->assertSame("$doc @@ websearch_to_tsquery('simple', \$[])", $postgres->fulltext($cols, $value, true));
        $this->assertNull($sqlite->fulltext($cols, $value, true));
    }
}
