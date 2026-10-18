<?php
// orm-gen --scan test: the generator declares, as @method tags of the model class, the chain methods that the scanned
// PHP sources call on a model (tests/generator/php-scan-vectors.json), resolves the receiver of a call from the source,
// rejects a name or an argument count the chain grammar does not accept, and leaves PHPStan with no method.notFound.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenScanTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\OrmGen;

#[Small]
final class OrmGenScanTest extends TestCase
{
    private const NS = 'Polyspec\\Orm\\Tests\\Scanned';

    private static string $work;

    public static function setUpBeforeClass(): void
    {
        self::$work = sys_get_temp_dir() . '/orm-php-orm-gen-scan-' . getmypid();
        @mkdir(self::$work, 0o700, true);
    }

    public static function tearDownAfterClass(): void
    {
        exec('rm -rf ' . escapeshellarg(self::$work));
    }

    /** @return array<string, array{array<string, mixed>}> */
    public static function vectors(): array
    {
        $file = dirname(__DIR__, 3) . '/tests/generator/php-scan-vectors.json';
        $out = [];
        foreach (json_decode((string) file_get_contents($file), true, 512, JSON_THROW_ON_ERROR)['cases'] as $case) {
            $out[$case['id']] = [$case];
        }
        return $out;
    }

    /** Generates the models of contracts/fixtures/bench/dbspec-set.json with --scan of $sources in a new folder; returns the code, stderr and the folder. */
    private static function generate(string $name, array $sources, array $extra = []): array
    {
        $dir = self::$work . '/' . $name;
        @mkdir("$dir/src", 0o700, true);
        $scan = [];
        foreach ($sources as $file => $text) {
            file_put_contents("$dir/src/$file", $text);
            $scan[] = '--scan';
            $scan[] = "$dir/src/$file";
        }
        $stderr = fopen('php://memory', 'w+');
        ob_start();
        $code = OrmGen::run(['gen', '--set', dirname(__DIR__, 3) . '/contracts/fixtures/bench/dbspec-set.json', '--out', "$dir/model", '--namespace', self::NS, ...$scan, ...$extra], $stderr);
        ob_end_clean();
        rewind($stderr);
        return [$code, (string) stream_get_contents($stderr), $dir];
    }

    /**
     * Generates the models of member.dbs, which uses core.dbs as an external document, with --scan of $sources in a new
     * folder; returns the code, stderr and the folder.
     */
    private static function generateExternal(string $name, array $sources): array
    {
        $root = dirname(__DIR__, 3);
        $dir = self::$work . '/' . $name;
        @mkdir("$dir/set/app", 0o700, true);
        @mkdir("$dir/set/core", 0o700, true);
        @mkdir("$dir/src", 0o700, true);
        copy("$root/contracts/fixtures/external/member.dbs", "$dir/set/app/member.dbs");
        copy("$root/contracts/fixtures/external/core.dbs", "$dir/set/core/core.dbs");
        $set = "$dir/set/app/dbspec-set.json";
        file_put_contents($set, json_encode(['schema' => 1, 'documents' => ['member.dbs'], 'external' => ['../core/core.dbs']], JSON_UNESCAPED_SLASHES));
        $scan = [];
        foreach ($sources as $file => $text) {
            file_put_contents("$dir/src/$file", $text);
            $scan[] = '--scan';
            $scan[] = "$dir/src/$file";
        }
        $stderr = fopen('php://memory', 'w+');
        ob_start();
        $code = OrmGen::run(['gen', '--set', $set, '--out', "$dir/model", '--namespace', self::NS, ...$scan], $stderr);
        ob_end_clean();
        rewind($stderr);
        return [$code, (string) stream_get_contents($stderr), $dir];
    }

    /** @return list<string> the methods the class comment of a model declares with @method, in file order */
    private static function tags(string $dir, string $class): array
    {
        preg_match_all('/^ \* @method \S+ (\w+)\(/m', (string) file_get_contents("$dir/model/$class.php"), $m);
        return $m[1];
    }

    #[DataProvider('vectors')]
    public function test_vector(array $case): void
    {
        $args = fn(int $n): string => implode(', ', array_fill(0, $n, '1'));
        $receiver = str_replace('{model}', $case['model'], $case['receiver'] ?? '$m');
        $steps = array_map(static fn(array $call): string => "{$call['name']}({$args($call['args'])})", $case['calls']);
        $calls = ($case['chain'] ?? false) ? "$receiver->" . implode('->', $steps) . ";\n"
            : implode('', array_map(static fn(string $step): string => "$receiver->$step;\n", $steps));
        $source = "<?php\nuse " . self::NS . "\\{$case['model']};\n\n\$db = null;\n\$m = new {$case['model']}();\n$calls";
        [$code, $err, $dir] = self::generate('vector-' . $case['id'], ['usage.php' => $source]);
        if (isset($case['expected']['rejected'])) {
            self::assertSame(1, $code, $case['id'] . ' status');
            self::assertStringContainsString($case['expected']['rejected'], $err, $case['id']);
            self::assertFileDoesNotExist("$dir/model/{$case['model']}.php", 'a rejected generation writes nothing');
            return;
        }
        self::assertSame(0, $code, $case['id'] . ': ' . $err);
        $declared = self::tags($dir, $case['model']);
        sort($declared, SORT_STRING);
        self::assertSame($case['expected']['declared'], $declared, $case['id']);
    }

    public function test_the_receiver_is_resolved_from_the_source(): void
    {
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\\Author as A;
use $ns\\User;
use $ns;

class Other
{
    public function geReadCount(int \$n): int { return \$n; }
}

function typed(A \$a, ?User \$u): void
{
    \$a->ltSeq(1);
    \$u?->lkName('x');
}

function made(): A
{
    return new A();
}

function chained(): void
{
    \$q = new A();
    \$q->andGtReadCount(1)->orLeUserSeq(2);
    made()->neServiceSeq(3);
    (new User())->gtSeq(4);
    \$q->and(fn(A \$m) => \$m->ltEndDt('2020-01-01'));
    \$q->or(function (\$m) { \$m->neName('n'); });
    foreach (\$q->gets() as \$row) {
        \$row->geLikeCount(5);
    }
    \$one = \$q->getBySeq(1);
    \$one->ltSuccessCount(6);
    (new \\$ns\\Service())->ltSeq(7);
}

function other(): void
{
    \$o = new Other();
    \$o->geReadCount(1);
    \$o->notAModelMethod(1);
    \$x = new \\stdClass();
    \$x->ltBogus(1);
}
PHP;
        [$code, $err, $dir] = self::generate('receivers', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
        $author = self::tags($dir, 'Author');
        sort($author, SORT_STRING);
        self::assertSame(['andGtReadCount', 'geLikeCount', 'getBySeq', 'ltEndDt', 'ltSeq', 'ltSuccessCount', 'neName', 'neServiceSeq', 'orLeUserSeq'], $author, 'Author');
        $user = self::tags($dir, 'User');
        sort($user, SORT_STRING);
        self::assertSame(['gtSeq', 'lkName'], $user, 'User');
        self::assertSame(['ltSeq'], self::tags($dir, 'Service'), 'Service');
    }

    public function test_an_alias_named_match_declares_its_getter(): void
    {
        $ns = self::NS;
        $source = <<<PHP
<?php
use $ns\\Author;
use $ns\\User;

\$a = (new Author())->relation((new User())->matchUserSeqWithSeq()->aliasMatch())
    ->relation((new User())->matchUserSeqWithSeq()->aliasJoin())->get();
\$a->getMatch();
\$a->getJoin();
PHP;
        [$code, $err, $dir] = self::generate('alias-match', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
        $author = self::tags($dir, 'Author');
        self::assertContains('getJoin', $author);
        self::assertContains('getMatch', $author);
    }

    public function test_a_nested_relation_alias_declares_its_getter_on_the_model_it_aliases_on(): void
    {
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\\Author;
use $ns\\User;

\$rows = (new Author())->relation((new User())->matchUserSeqWithSeq()->aliasWriter()
    ->relation((new Author())->matchSeqWithUserSeq()->aliasMatch()))->gets();
foreach (\$rows as \$row) {
    /** @var User|null \$writer */
    \$writer = \$row->getWriter();
    \$writer?->getMatch();
}
PHP;
        [$code, $err, $dir] = self::generate('nested-alias', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
        self::assertContains('getWriter', self::tags($dir, 'Author'));
        self::assertContains('getMatch', self::tags($dir, 'User'));
    }

    public function test_a_getter_call_that_nothing_attaches_stops_generation(): void
    {
        $ns = self::NS;
        $source = <<<PHP
<?php
use $ns\\Author;
use $ns\\User;

\$rows = (new Author())->relation((new User())->matchUserSeqWithSeq()->aliasWriter())->gets();
foreach (\$rows as \$row) {
    /** @var User|null \$writer */
    \$writer = \$row->getWriter();
    \$writer?->getGhost();
}
PHP;
        [$code, $err, $dir] = self::generate('unattached-getter', ['usage.php' => $source]);
        self::assertSame(1, $code, 'status');
        self::assertStringContainsString('User.getGhost is called, but no aliasGhost, newGhost or addColumn call attaches it', $err);
        self::assertFileDoesNotExist("$dir/model/User.php", 'a refused generation writes nothing');
    }

    public function test_a_relation_to_an_entity_of_a_used_document_attaches_its_getter(): void
    {
        // ext_post of member.dbs uses ext_audit of core.dbs, an external document: the relation to ExtAudit attaches
        // getExtAuditModel as it does for a local entity.
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\\ExtPost;

\$rows = (new ExtPost())->relation((new ExtAudit())->connect(\$db)->matchAuditSeqWithSeq())->gets();
foreach (\$rows as \$row) {
    \$row->getExtAuditModel();
}
PHP;
        [$code, $err] = self::generateExternal('external-getter', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
    }

    public function test_a_name_is_typed_by_its_binding_in_its_own_scope(): void
    {
        // The outer row is a ServiceMember. A destructuring assignment and an if with differing branches leave row with a
        // class the scan cannot type, so their setIsClose calls are not the outer ServiceMember's; the call on an Author row
        // in another function is attributed to Author.
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\\Author;
use $ns\\ServiceMember;

function read(array \$blocks, bool \$flag): void
{
    \$row = new ServiceMember();
    [\$row] = \$blocks;
    \$row->setIsClose(true);
    if (\$flag) {
        \$row = new Author();
    } else {
        \$row = \$blocks[0];
    }
    \$row->setIsClose(false);
}

function write_author(): void
{
    \$row = new Author();
    \$row->setIsClose(false);
}
PHP;
        [$code, $err] = self::generate('scope-binding', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
    }

    public function test_a_name_that_may_hold_two_models_gets_the_call_on_each(): void
    {
        // Each branch binds row to another model, so the call after the if is on either: each class declares the method.
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\\Author;
use $ns\\ServiceMember;

function branches(bool \$flag): void
{
    if (\$flag) {
        \$row = new ServiceMember();
    } else {
        \$row = new Author();
    }
    \$row->ltSeq(1);
}

function cases(int \$k): void
{
    switch (\$k) {
        case 1:
            \$row = new ServiceMember();
            break;
        default:
            \$row = new Author();
    }
    \$row->geSeq(2);
}

function attempts(): void
{
    try {
        \$row = new ServiceMember();
    } catch (\\Exception \$e) {
        \$row = new Author();
    }
    \$row->leSeq(3);
}

function loops(bool \$more): void
{
    \$row = new Author();
    while (\$more) {
        \$row->neSeq(4);
        \$row = new ServiceMember();
    }
}
PHP;
        [$code, $err, $dir] = self::generate('may-hold', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
        foreach (['Author', 'ServiceMember'] as $class) {
            foreach (['ltSeq', 'geSeq', 'leSeq', 'neSeq'] as $method) {
                self::assertContains($method, self::tags($dir, $class), "$class declares $method");
            }
        }
    }

    public function test_a_reference_forgets_both_names(): void
    {
        // $alias and $row are one variable after the reference, so the call on $row is not attributed to Author.
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\\Author;

function alias(): void
{
    \$row = new Author();
    \$alias = &\$row;
    \$row->ltSeq(1);
}
PHP;
        [$code, $err, $dir] = self::generate('reference', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
        self::assertNotContains('ltSeq', self::tags($dir, 'Author'));
    }

    /** A getter on a name that may hold two models is refused only when no possible class has it: Author has is_close, User does not. */
    public function test_a_possible_class_with_the_getter_accepts_the_call_after_an_if(): void
    {
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\Author;
use $ns\User;

function branch(bool \$x): void
{
    \$row = new Author();
    if (\$x) {
        \$row = new User();
    }
    \$row->getIsClose();
}
PHP;
        [$code, $err] = self::generate('a_possible_class_with_the_getter_accepts_the_call_after_an_if', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
    }

    public function test_a_possible_class_with_the_getter_accepts_the_call_in_a_loop(): void
    {
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\Author;
use $ns\User;

function loops(): void
{
    \$row = new Author();
    for (\$i = 0; \$i < 3; \$i++) {
        if (\$i > 0) {
            \$row->getIsClose();
        }
        \$row = new User();
    }
}
PHP;
        [$code, $err] = self::generate('a_possible_class_with_the_getter_accepts_the_call_in_a_loop', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
    }

    public function test_a_branch_that_returns_contributes_nothing(): void
    {
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\Author;
use $ns\User;

function returns(bool \$x): void
{
    \$row = new Author();
    if (\$x) {
        \$row = new User();
        return;
    }
    \$row->getIsClose();
}
PHP;
        [$code, $err] = self::generate('a_branch_that_returns_contributes_nothing', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
    }

    public function test_a_loop_that_may_run_zero_times_keeps_the_class_before_it(): void
    {
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\Author;
use $ns\User;

function zero(array \$xs): void
{
    \$row = new Author();
    foreach (\$xs as \$x) {
        \$row = new User();
    }
    \$row->getIsClose();
}
PHP;
        [$code, $err] = self::generate('a_loop_that_may_run_zero_times_keeps_the_class_before_it', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
    }

    public function test_a_null_assignment_contributes_nothing(): void
    {
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\Author;
use $ns\User;

function nothing(bool \$x): void
{
    \$row = null;
    if (\$x) {
        \$row = new User();
    }
    \$row->getIsClose();
}
PHP;
        [$code, $err] = self::generate('a_null_assignment_contributes_nothing', ['usage.php' => $source]);
        self::assertSame(1, $code, $err);
        self::assertStringContainsString('User.getIsClose is called', $err);
    }

    public function test_a_reference_in_a_loop_forgets_both_names_at_its_entry(): void
    {
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\Author;
use $ns\User;

function loops(bool \$more): void
{
    \$row = new Author();
    while (\$more) {
        \$row->getOwner();
        \$alias = &\$row;
    }
}
PHP;
        [$code, $err] = self::generate('a_reference_in_a_loop_forgets_both_names_at_its_entry', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
    }

    /** A model method is refused only when no possible class declares it: Author has is_close, ServiceMember does not. */
    public function test_a_method_is_refused_only_when_no_possible_class_declares_it(): void
    {
        $ns = self::NS;
        $branch = <<<PHP
<?php
namespace App;

use $ns\Author;
use $ns\ServiceMember;

function branch(bool \$x): void
{
    if (\$x) {
        \$row = new Author();
        exit(1);
    } else {
        \$row = new ServiceMember();
    }
    \$row->neIsClose(true);
}
PHP;
        [$code, $err] = self::generate('method-branch', ['usage.php' => $branch]);
        self::assertSame(0, $code, $err);
        $try = <<<PHP
<?php
namespace App;

use $ns\Author;
use $ns\ServiceMember;

function attempts(): void
{
    try {
        \$row = new Author();
    } catch (\\Exception \$e) {
        \$row = new ServiceMember();
    }
    \$row->neIsClose(true);
}
PHP;
        [$code, $err] = self::generate('method-try', ['usage.php' => $try]);
        self::assertSame(0, $code, $err);
        // A handler that rethrows contributes nothing, so the call is on Author alone.
        $rethrow = <<<PHP
<?php
namespace App;

use $ns\Author;
use $ns\ServiceMember;

function rethrows(): void
{
    try {
        \$row = new Author();
    } catch (\\Exception \$e) {
        \$row = new ServiceMember();
        throw \$e;
    }
    \$row->neIsClose(true);
}
PHP;
        [$code, $err] = self::generate('method-rethrow', ['usage.php' => $rethrow]);
        self::assertSame(0, $code, $err);
    }

    /** A try that assigns the name on every path leaves no outcome with the value from before the try. */
    public function test_a_try_leaves_no_outcome_with_the_value_before_it(): void
    {
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\Author;
use $ns\ServiceMember;

function attempts(): void
{
    \$row = new Author();
    try {
        \$row = new ServiceMember();
    } catch (\\Exception \$e) {
        \$row = new ServiceMember();
    }
    \$row->neIsClose(true);
}
PHP;
        [$code, $err] = self::generate('try-no-base', ['usage.php' => $source]);
        self::assertSame(1, $code, 'status');
        self::assertStringContainsString('ServiceMember.neIsClose is not a model method', $err);
    }

    /**
     * Generates the models of shapes.dbs, whose alpha and beta tables share the name flag with a boolean and a datetime column, with
     * --scan of $source in a new folder; returns the code, stderr and the folder.
     */
    private static function generateShapes(string $name, string $source): array
    {
        $dir = self::$work . '/' . $name;
        @mkdir("$dir/set", 0o700, true);
        @mkdir("$dir/src", 0o700, true);
        file_put_contents("$dir/set/shapes.dbs", "dbspec 1 shapes\n\ntable alpha {\n  seq i64 identity\n  flag bool\n  primary key (seq)\n}\n\ntable beta {\n  seq i64 identity\n  flag datetime(6)\n  primary key (seq)\n}\n");
        $set = "$dir/set/dbspec-set.json";
        file_put_contents($set, json_encode(['schema' => 1, 'documents' => ['shapes.dbs']], JSON_UNESCAPED_SLASHES));
        file_put_contents("$dir/src/usage.php", $source);
        $stderr = fopen('php://memory', 'w+');
        ob_start();
        $code = OrmGen::run(['gen', '--set', $set, '--out', "$dir/model", '--namespace', self::NS, '--scan', "$dir/src/usage.php"], $stderr);
        ob_end_clean();
        rewind($stderr);
        return [$code, (string) stream_get_contents($stderr), $dir];
    }

    /** An argument count is accepted when one class that may hold the name accepts it, and refused when no possible class does. */
    public function test_an_argument_count_is_refused_only_when_no_possible_class_accepts_it(): void
    {
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\Alpha;
use $ns\Beta;

function read(bool \$x): void
{
    if (\$x) {
        \$row = new Alpha();
    } else {
        \$row = new Beta();
    }
    \$row->neFlag(true, false);
}
PHP;
        // Alpha takes one argument and Beta takes two (its datetime column takes the optional comparison): two arguments are accepted.
        [$code, $err] = self::generateShapes('count-one-accepts', $source);
        self::assertSame(0, $code, $err);
        // No class takes three arguments, so the call is refused, naming the class that declares the method.
        [$code, $err] = self::generateShapes('count-none-accepts', str_replace('neFlag(true, false)', 'neFlag(true, false, true)', $source));
        self::assertSame(1, $code, 'status');
        self::assertStringContainsString('Alpha.neFlag takes 1 argument, called with 3', $err);
    }

    /** A zero-iteration foreach keeps the value the name had before the loop, so the call is on Author or User. */
    public function test_a_zero_iteration_foreach_keeps_the_value_before_it(): void
    {
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\Author;
use $ns\User;

function loops(): void
{
    \$row = new Author();
    \$rows = (new User())->gets();
    foreach (\$rows as \$row) {
    }
    \$row->neIsClose(true);
}
PHP;
        [$code, $err] = self::generate('foreach-before', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
    }

    /** A typed, variadic or arrow-function parameter named like an outer model variable is not that model. */
    public function test_a_parameter_named_like_an_outer_model_is_not_that_model(): void
    {
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\Author;

\$module = new Author();
\$arrow = fn(Holder \$module) => \$module->setGhostColumn(true);
function typed(Holder \$module): void
{
    \$module->setGhostColumn(true);
}
function variadic(...\$module): void
{
    \$module->setGhostColumn(true);
}
PHP;
        [$code, $err] = self::generate('parameter-shadowing', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
    }

    public function test_a_restore_or_create_call_is_a_model_method(): void
    {
        // restoreOrCreate is a public method of Model, so a scanned call to it is accepted.
        $ns = self::NS;
        $source = <<<PHP
<?php
use $ns\\Author;

\$row = (new Author())->restoreOrCreate();
PHP;
        [$code, $err] = self::generate('restore-or-create', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
    }

    public function test_a_directory_is_scanned_and_a_file_that_does_not_parse_fails_the_scan(): void
    {
        $dir = self::$work . '/directory';
        @mkdir("$dir/src/nested", 0o700, true);
        file_put_contents("$dir/src/nested/a.php", "<?php\n\$a = new " . self::NS . "\\Author();\n\$a->ltSeq(1);\n");
        file_put_contents("$dir/src/notes.txt", "ltIgnored(");
        $run = function (string $out) use ($dir): array {
            $stderr = fopen('php://memory', 'w+');
            ob_start();
            $code = OrmGen::run(['gen', '--set', dirname(__DIR__, 3) . '/contracts/fixtures/bench/dbspec-set.json', '--out', $out, '--namespace', self::NS, '--scan', "$dir/src"], $stderr);
            ob_end_clean();
            rewind($stderr);
            return [$code, (string) stream_get_contents($stderr)];
        };
        [$code, $err] = $run("$dir/model");
        self::assertSame(0, $code, $err);
        self::assertSame(['ltSeq'], self::tags($dir, 'Author'));
        file_put_contents("$dir/src/broken.php", "<?php\n\$a = new (;\n");
        [$code, $err] = $run("$dir/model2");
        self::assertSame(1, $code);
        self::assertStringContainsString('broken.php', $err);
    }

    public function test_a_scanned_directory_skips_its_dependencies_and_refuses_a_symlink(): void
    {
        $dir = self::$work . '/links';
        mkdir("$dir/src/vendor/pkg", 0o700, true);
        file_put_contents("$dir/src/a.php", "<?php\n\$a = new " . self::NS . "\\Author();\n\$a->ltSeq(1);\n");
        file_put_contents("$dir/src/vendor/pkg/b.php", "<?php\n\$a = new " . self::NS . "\\Author();\n\$a->gtSeq(1);\n");
        $run = function (string $out) use ($dir): array {
            $stderr = fopen('php://memory', 'w+');
            ob_start();
            $code = OrmGen::run(['gen', '--set', dirname(__DIR__, 3) . '/contracts/fixtures/bench/dbspec-set.json', '--out', $out, '--namespace', self::NS, '--scan', "$dir/src"], $stderr);
            ob_end_clean();
            rewind($stderr);
            return [$code, (string) stream_get_contents($stderr)];
        };
        [$code, $err] = $run("$dir/model");
        self::assertSame(0, $code, $err);
        self::assertSame(['ltSeq'], self::tags($dir, 'Author'));
        mkdir("$dir/elsewhere", 0o700, true);
        file_put_contents("$dir/elsewhere/c.php", "<?php\n\$a = new " . self::NS . "\\Author();\n\$a->geSeq(1);\n");
        symlink("$dir/elsewhere", "$dir/src/linked");
        [$code, $err] = $run("$dir/model2");
        self::assertSame(1, $code);
        self::assertStringContainsString("$dir/src/linked is a symlink", $err);
    }

    public function test_check_compares_the_models_with_the_scan(): void
    {
        $source = "<?php\n\$a = new " . self::NS . "\\Author();\n\$a->ltSeq(1);\n";
        [$code, $err, $dir] = self::generate('check', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
        $stderr = fopen('php://memory', 'w+');
        ob_start();
        $args = ['gen', '--set', dirname(__DIR__, 3) . '/contracts/fixtures/bench/dbspec-set.json', '--out', "$dir/model", '--namespace', self::NS, '--scan', "$dir/src/usage.php", '--check'];
        self::assertSame(0, OrmGen::run($args, $stderr), 'current');
        self::assertSame('', (string) ob_get_clean());
        file_put_contents("$dir/src/usage.php", $source . "\$a->gtSeq(1);\n");
        ob_start();
        self::assertSame(1, OrmGen::run($args, $stderr), 'stale');
        self::assertSame("differs: $dir/model/Author.php\n", (string) ob_get_clean());
    }

    public function test_phpstan_finds_every_scanned_chain_method(): void
    {
        $root = dirname(__DIR__, 3);
        $ns = self::NS;
        $used = <<<PHP
<?php
declare(strict_types=1);

use $ns\\Author;
use $ns\\User;

function calls(Author \$a, User \$u, Polyspec\\Orm\\Db \$db): Author
{
    \$a->ltSeq(1)->andGeReadCount(2)->orNeIsClose(true)->lkName('n')->seqAndName(1, 'a')->betweenReadCount([1, 5]);
    \$a->gtStartDt(\\Polyspec\\Orm\\Func::class === '' ? new DateTimeImmutable() : new DateTimeImmutable());
    \$a->getsBySeqAndIsClose(1, false);
    \$a->orderBySeqDescAndNameAsc()->joinUserSeqWithSeq(\$u)->tupleUserSeqWithServiceSeq([[1, 2]]);
    \$a->aliasMine()->newExtra(1)->possibleSeq(1);
    (new Author())->gtSeq(1)->andLeReadCount(2);
    (new Author())(\$db)->andLtEndDt(new DateTimeImmutable())->orderBySeqAsc();
    \$u->neName('x');
    return \$a;
}
PHP;
        [$code, $err, $dir] = self::generate('phpstan', ['usage.php' => $used]);
        self::assertSame(0, $code, $err);
        file_put_contents("$dir/models.php", "<?php\nspl_autoload_register(static function (string \$class): void {\n"
            . "    \$prefix = '" . addslashes($ns) . "\\\\';\n"
            . "    if (str_starts_with(\$class, \$prefix)) {\n        require " . var_export("$dir/model/", true) . " . substr(\$class, strlen(\$prefix)) . '.php';\n    }\n});\n");
        file_put_contents("$dir/autoload.php", "<?php\nrequire " . var_export("$root/packages/php/tests/autoload.php", true) . ";\nrequire " . var_export("$dir/models.php", true) . ";\n");
        file_put_contents("$dir/phpstan.neon", "parameters:\n    tmpDir: $dir/phpstan-cache\n");
        // A call that the sources of the scan do not make is not declared: the control that makes the zero meaningful.
        file_put_contents("$dir/control.php", "<?php\ndeclare(strict_types=1);\n\nfunction control(\\$ns\\Author \$a): void\n{\n    \$a->ltReadCount(1);\n}\n");
        $analyse = function (string $file) use ($root, $dir): array {
            $command = [PHP_BINARY, "$root/vendor-php/bin/phpstan", 'analyse', '--no-progress', '--no-ansi', '--error-format=json',
                '--configuration', "$dir/phpstan.neon", '--level=9', '--memory-limit=512M', '--autoload-file', "$dir/autoload.php", $file];
            $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $root);
            $out = (string) stream_get_contents($pipes[1]);
            $err = (string) stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            $status = proc_close($process);
            // PHPStan exits 0 without errors and 1 with errors; any other status is a run that did not analyse.
            self::assertContains($status, [0, 1], "phpstan analyse $file exited with $status:\n$out$err");
            // The JSON report names the identifier of each error (files.<path>.messages[].identifier), so a finding is matched by
            // its identifier, not by the text of a format.
            $report = json_decode($out, true, flags: JSON_THROW_ON_ERROR);
            self::assertIsArray($report, "phpstan analyse $file wrote no JSON report:\n$out$err");
            $findings = [];
            foreach ((array) ($report['files'] ?? []) as $path => $entry) {
                foreach ((array) (is_array($entry) ? ($entry['messages'] ?? []) : []) as $message) {
                    self::assertIsArray($message, "phpstan analyse $file reported a message that is not an object:\n$out");
                    $findings[] = sprintf('%s:%s: %s [%s]', $path, $message['line'] ?? '?', $message['message'] ?? '', $message['identifier'] ?? 'no identifier');
                }
            }
            return [$findings, $out . $err, $status];
        };
        [$findings, $raw] = $analyse("$dir/src/usage.php");
        $notFound = array_values(array_filter($findings, static fn(string $line): bool => str_ends_with($line, '[method.notFound]')));
        self::assertSame([], $notFound, "method.notFound:\n" . implode("\n", $notFound) . "\n$raw");
        [$control, $controlRaw, $controlStatus] = $analyse("$dir/control.php");
        self::assertSame(1, $controlStatus, "the control call is declared:\n$controlRaw");
        self::assertNotSame([], array_filter($control, static fn(string $line): bool => str_ends_with($line, '[method.notFound]')), "the control call is declared:\n$controlRaw");
    }
}
