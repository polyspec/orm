<?php

// orm-gen --scan test: the generator declares, as @method tags of the model class, the chain methods that the scanned
// PHP sources call on a model (tests/generator/php-scan-vectors.json), resolves the receiver of a call from the source,
// rejects a name or an argument count the chain grammar does not accept, and leaves PHPStan with no method.notFound.
// Requirements: SCH-1, DSL-152.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php-gen/tests/OrmGenScanTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProviderExternal;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class OrmGenScanTest extends TestCase
{
    use OrmGenScanFailureCase;

    private const NS = 'Polyspec\\Orm\\Tests\\Scanned';

    private static string $work;

    public static function setUpBeforeClass(): void
    {
        self::$work = OrmGenTestSupport::createWorkDirectory('orm-php-orm-gen-scan-');
    }

    public static function tearDownAfterClass(): void
    {
        OrmGenTestSupport::removeWorkDirectory(self::$work);
    }

    /**
     * The usage source of an Author model of the scanned namespace that imports Author, ServiceMember and User and runs
     * `$lines` in order: a list is a relation call on `$author` of [method, related model, chain, terminal], a string
     * a statement as it is.
     *
     * @param list<string|array{string, string, string, ?string}> $lines
     */
    private static function authorUsage(array $lines, ?string $namespace = null): string
    {
        return OrmGenTestSupport::phpModelSource(
            'Author',
            'author',
            [self::NS . '\\Author', self::NS . '\\ServiceMember', self::NS . '\\User'],
            implode("\n", array_map(
                static fn(string|array $line): string => is_string($line)
                    ? $line
                    : OrmGenTestSupport::phpRelationCall('$author', ...$line),
                $lines
            )) . "\n",
            $namespace
        );
    }

    /** @param array<string, string> $sources @return list<string> */
    private static function scanArguments(string $dir, array $sources): array
    {
        is_dir("$dir/src") || mkdir("$dir/src", 0o700, true);
        $scan = [];
        foreach ($sources as $file => $text) {
            file_put_contents("$dir/src/$file", $text);
            $scan[] = '--scan';
            $scan[] = "$dir/src/$file";
        }
        return $scan;
    }

    /** @param list<string> $args @return array{int, string} */
    private static function runGenerator(array $args): array
    {
        [$code, , $error] = OrmGenTestSupport::run($args);
        return [$code, $error];
    }

    /** @return array{int, string} */
    private static function runScanDirectory(string $dir, string $out): array
    {
        return self::runScan(
            dirname(__DIR__, 3) . '/contracts/fixtures/bench/dbspec-set.json',
            $out,
            ['--scan', "$dir/src"]
        );
    }

    /** @param list<string> $scan @param list<string> $extra @return array{int, string} */
    private static function runScan(string $set, string $out, array $scan, array $extra = []): array
    {
        return self::runGenerator([
            'gen', '--set', $set, '--out', $out, '--namespace', self::NS, ...$scan, ...$extra
        ]);
    }

    /**
     * Generates the models of contracts/fixtures/bench/dbspec-set.json with --scan of $sources in a new folder; returns
     * the code, stderr and the folder.
     */
    private static function generate(string $name, array $sources, array $extra = []): array
    {
        return self::generateFromSet(
            $name,
            $sources,
            dirname(__DIR__, 3) . '/contracts/fixtures/bench/dbspec-set.json',
            $extra
        );
    }

    /** @param array<string, string> $sources @param list<string> $extra @return array{int, string, string} */
    private static function generateFromSet(string $name, array $sources, string $set, array $extra = []): array
    {
        $dir = self::$work . '/' . $name;
        $scan = self::scanArguments($dir, $sources);
        [$code, $stderr] = self::runScan($set, "$dir/model", $scan, $extra);
        return [$code, $stderr, $dir];
    }

    /**
     * Generates the models of member.dbs (or of $owned as note.dbs when given), which uses core.dbs as an external
     * document, with --scan of $sources in a new folder; returns the code, stderr and the folder.
     */
    private static function generateExternal(string $name, array $sources, ?string $owned = null): array
    {
        $root = dirname(__DIR__, 3);
        $dir = self::$work . '/' . $name;
        is_dir("$dir/set/app") || mkdir("$dir/set/app", 0o700, true);
        is_dir("$dir/set/core") || mkdir("$dir/set/core", 0o700, true);
        $document = $owned === null ? 'member.dbs' : 'note.dbs';
        if ($owned === null) {
            copy("$root/contracts/fixtures/external/member.dbs", "$dir/set/app/$document");
        } else {
            file_put_contents("$dir/set/app/$document", $owned);
        }
        copy("$root/contracts/fixtures/external/core.dbs", "$dir/set/core/core.dbs");
        $set = OrmGenTestSupport::setFile("$dir/set/app", [$document], ['../core/core.dbs']);
        return self::generateFromSet($name, $sources, $set);
    }

    /** @return list<string> the methods the class comment of a model declares with @method, in file order */
    private static function tags(string $dir, string $class): array
    {
        return OrmGenTestSupport::phpMethodNames("$dir/model/$class.php");
    }

    // Requirements: DSL-37, DSL-38, DSL-42, PLN-1.
    #[DataProviderExternal(OrmGenTestSupport::class, 'phpScanVectorCases')]
    public function testVector(array $case): void
    {
        // The test of DSL-42 (docs/spec).
        $args = fn(int $n): string => implode(', ', array_fill(0, $n, '1'));
        $receiver = str_replace('{model}', $case['model'], $case['receiver'] ?? '$m');
        $steps = array_map(static fn(array $call): string => "{$call['name']}({$args($call['args'])})", $case['calls']);
        $calls = ($case['chain'] ?? false) ? "$receiver->" . implode('->', $steps) . ";\n"
            : implode('', array_map(static fn(string $step): string => "$receiver->$step;\n", $steps));
        // A case with a body gives its own statements in place of the calls, for the typed getters (DSL-42).
        if (isset($case['body'])) {
            $calls = $case['body'];
        }
        $source = OrmGenTestSupport::phpScanFixture(
            $case['model'],
            $calls,
            self::NS . "\\{$case['model']}"
        );
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
        foreach ($case['expected']['types'] ?? [] as $name => $type) {
            self::assertSame($type, self::tagType($dir, $case['model'], $name), "$name of {$case['id']}");
        }
    }

    /** @return string the type that the class comment declares for the getter $name, with @method */
    private static function tagType(string $dir, string $class, string $name): string
    {
        $source = (string) file_get_contents("$dir/model/$class.php");
        preg_match('/^ \* @method (\S+) ' . preg_quote($name, '/') . '\(/m', $source, $m);
        return $m[1] ?? '';
    }

    public function testTheReceiverIsResolvedFromTheSource(): void
    {
        // Requirements: INT-28, PLN-1, PLN-40.
        // The test of DSL-42 (docs/spec).
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
        self::assertSame(
            [
                'andGtReadCount',
                'geLikeCount',
                'getBySeq',
                'ltEndDt',
                'ltSeq',
                'ltSuccessCount',
                'neName',
                'neServiceSeq',
                'orLeUserSeq'
            ],
            $author,
            'Author'
        );
        $user = self::tags($dir, 'User');
        sort($user, SORT_STRING);
        self::assertSame(['gtSeq', 'lkName'], $user, 'User');
        self::assertSame(['ltSeq'], self::tags($dir, 'Service'), 'Service');
    }

    public function testAnAliasNamedMatchDeclaresItsGetter(): void
    {
        // The test of DSL-44 (docs/spec).
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

    public function testRelationAliasTypesFollowRelationEdgesAndExplicitAliases(): void
    {
        $source = self::authorUsage([
            ['relation', 'User', 'matchUserSeqWithSeq()->aliasOldWriter()->aliasWriter()', 'gets'],
            '$author->getWriter();',
            ['relation', 'User', 'matchUserSeqWithSeq()->aliasWriter()', 'get'],
            ['relations', 'ServiceMember', 'matchServiceSeqWithServiceSeq()->aliasMembers()', 'get'],
            '$author->getMembers();',
            [
                'relation',
                'User',
                'matchUserSeqWithSeq()->aliasNestedWriter()'
                    . '->relation((new Author())->matchSeqWithUserSeq()->aliasMatch())',
                'gets',
            ],
            '$author->getNestedWriter();',
            '$user = new User();',
            '$user->getMatch();',
            '$author->getUserModel();',
            ['relations', 'ServiceMember', 'matchServiceSeqWithServiceSeq()->aliasUserModel()', 'gets'],
            '$author->getUserModel();'
        ], 'App');
        [$code, $err, $dir] = self::generate('relation-alias-types', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
        self::assertSame('?User', self::tagType($dir, 'Author', 'getWriter'));
        self::assertSame('\\Polyspec\\Orm\\Collection<ServiceMember>', self::tagType($dir, 'Author', 'getMembers'));
        self::assertSame('?User', self::tagType($dir, 'Author', 'getNestedWriter'));
        self::assertSame('\\Polyspec\\Orm\\Collection<ServiceMember>', self::tagType($dir, 'Author', 'getUserModel'));
        self::assertNotContains('getOldWriter', self::tags($dir, 'Author'));
        self::assertSame('?Author', self::tagType($dir, 'User', 'getMatch'));
    }

    public function testSupersededRelationAliasDoesNotDeclareItsGetterType(): void
    {
        $source = OrmGenTestSupport::phpModelSource(
            'Author',
            'author',
            [self::NS . '\\Author', self::NS . '\\User'],
            implode("\n", [
                OrmGenTestSupport::phpRelationCall(
                    '$author',
                    'relation',
                    'User',
                    'matchUserSeqWithSeq()->aliasOldWriter()->aliasWriter()',
                    'gets'
                ),
                '$author->getOldWriter();'
            ]) . "\n"
        );
        [$code, $err] = self::generate('superseded-relation-alias', ['usage.php' => $source]);
        self::assertSame(1, $code, 'status');
        self::assertStringContainsString('Author.getOldWriter: no get or gets reads the alias', $err);
    }

    public function testDifferentRelationAliasTypesAreRejected(): void
    {
        $source = self::authorUsage([
            ['relation', 'User', 'matchUserSeqWithSeq()->aliasShared()', null],
            ['relations', 'User', 'matchUserSeqWithSeq()->aliasShared()', null],
            ['relation', 'ServiceMember', 'matchServiceSeqWithServiceSeq()->aliasShared()', 'getShared']
        ]);
        [$code, $err, $dir] = self::generate('relation-alias-conflict', ['usage.php' => $source]);
        self::assertSame(1, $code, 'status');
        self::assertStringContainsString('Author.getShared: relation declarations conflict', $err);
        self::assertMatchesRegularExpression('/aliasShared at line \\d+ => \\?User/', $err);
        self::assertMatchesRegularExpression(
            '/aliasShared at line \\d+ => \\\\Polyspec\\\\Orm\\\\Collection<User>/',
            $err
        );
        self::assertMatchesRegularExpression('/aliasShared at line \\d+ => \\?ServiceMember/', $err);
        self::assertFileDoesNotExist("$dir/model/Author.php", 'a rejected generation writes nothing');
    }

    public function testImplicitRelationAndExplicitAliasCannotAttachDifferentTypesToOneGetter(): void
    {
        $source = self::authorUsage([
            ['relation', 'User', 'matchUserSeqWithSeq()', null],
            ['relations', 'ServiceMember', 'matchServiceSeqWithServiceSeq()->aliasUserModel()', null]
        ]);
        [$code, $err] = self::generate('implicit-explicit-relation-alias-conflict', ['usage.php' => $source]);
        self::assertSame(1, $code, 'status');
        self::assertStringContainsString('Author.getUserModel: relation declarations conflict', $err);
        self::assertMatchesRegularExpression('/relation at line \\d+ => \\?User/', $err);
        self::assertMatchesRegularExpression(
            '/aliasUserModel at line \\d+ => \\\\Polyspec\\\\Orm\\\\Collection<ServiceMember>/',
            $err
        );
    }

    public function testRelationKeywordCaseDoesNotChangeRelationTypeConflict(): void
    {
        $source = self::authorUsage([
            ['RELATIONS', 'ServiceMember', 'matchServiceSeqWithServiceSeq()', null],
            ['relation', 'User', 'matchUserSeqWithSeq()->aliasServiceMemberModels()', 'getServiceMemberModels']
        ]);
        [$code, $err] = self::generate('relation-keyword-case-conflict', ['usage.php' => $source]);
        self::assertSame(1, $code, 'status');
        self::assertStringContainsString('Author.getServiceMemberModels: relation declarations conflict', $err);
        self::assertMatchesRegularExpression(
            '/relations at line \d+ => \\\\Polyspec\\\\Orm\\\\Collection<ServiceMember>/',
            $err
        );
        self::assertMatchesRegularExpression('/aliasServiceMemberModels at line \d+ => \?User/', $err);
    }

    public function testUnusedRelationAliasDoesNotGenerateAGetter(): void
    {
        $ns = self::NS;
        $source = <<<PHP
<?php
use $ns\\Author;
use $ns\\User;

(new Author())->relation((new User())->matchUserSeqWithSeq()->aliasUnused())->get();
PHP;
        [$code, $err, $dir] = self::generate('unused-relation-alias', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
        self::assertNotContains('getUnused', self::tags($dir, 'Author'));
    }

    // Requirements: DBS-118.
    public function testANestedRelationAliasDeclaresItsGetterOnTheModelItAliasesOn(): void
    {
        // The test of DSL-44 (docs/spec).
        $source = OrmGenTestSupport::phpSource(
            [self::NS . '\\Author', self::NS . '\\User'],
            '$rows = ' . OrmGenTestSupport::phpRelationCall(
                '(new Author())',
                'relation',
                'User',
                'matchUserSeqWithSeq()->aliasWriter()'
                    . "\n    ->relation((new Author())->matchSeqWithUserSeq()->aliasMatch())",
                'gets'
            ) . "\n"
                . "foreach (\$rows as \$row) {\n"
                . "    /** @var User|null \$writer */\n"
                . "    \$writer = \$row->getWriter();\n"
                . "    \$writer?->getMatch();\n"
                . "}\n",
            'App'
        );
        [$code, $err, $dir] = self::generate('nested-alias', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
        self::assertContains('getWriter', self::tags($dir, 'Author'));
        self::assertContains('getMatch', self::tags($dir, 'User'));
    }

    public function testAGetterCallThatNothingAttachesStopsGeneration(): void
    {
        // The test of DSL-44 (docs/spec).
        $source = OrmGenTestSupport::phpSource(
            [self::NS . '\\Author', self::NS . '\\User'],
            '$rows = ' . OrmGenTestSupport::phpRelationCall(
                '(new Author())',
                'relation',
                'User',
                'matchUserSeqWithSeq()->aliasWriter()',
                'gets'
            ) . "\n"
                . "foreach (\$rows as \$row) {\n"
                . "    /** @var User|null \$writer */\n"
                . "    \$writer = \$row->getWriter();\n"
                . "    \$writer?->getGhost();\n"
                . "}\n"
        );
        [$code, $err, $dir] = self::generate('unattached-getter', ['usage.php' => $source]);
        self::assertSame(1, $code, 'status');
        self::assertStringContainsString(
            'User.getGhost is called, but no aliasGhost, newGhost or addColumn call attaches it',
            $err
        );
        self::assertFileDoesNotExist("$dir/model/User.php", 'a refused generation writes nothing');
    }

    public function testACallOnAClassOfAnotherSetIsNotThisSetsCall(): void
    {
        // Requirements: DSL-151.
        // Another set's output shares the class name Author: a call on it, through a use import or a qualified name,
        // declares and refuses nothing on this set's Author.
        $ns = self::NS;
        $source = <<<PHP
<?php
use Polyspec\\Orm\\Tests\\OtherSet\\Author;
use $ns\\User;

(new Author())->ltSeq(1);
(new Author())->getGhost();
(new \\Polyspec\\Orm\\Tests\\OtherSet\\Author())->gtReadCount(1);
(new User())->neName('x');
PHP;
        [$code, $err, $dir] = self::generate('imported-set', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
        self::assertNotContains('ltSeq', self::tags($dir, 'Author'));
        self::assertNotContains('gtReadCount', self::tags($dir, 'Author'));
        self::assertContains('neName', self::tags($dir, 'User'));
    }

    public function testAReceiverHeldInAReassignedVariableResolvesToItsClass(): void
    {
        // Requirements: DSL-151.
        // A variable initialized from a chain on an imported class and reassigned from its own chain in a conditional
        // expression still holds that class, as the checker types it, so the calls on it after each reassignment are
        // its calls.
        $ns = self::NS;
        $source = <<<PHP
<?php
use $ns\\Author;

function page(\$db, ?int \$limit): Author
{
    \$page = (new Author())->connect(\$db)->addAllColumns();
    \$conditions = 0;
    if (\$limit !== null) {
        \$page = \$conditions === 0 ? \$page->gtReadCount(\$limit) : \$page->andGtReadCount(\$limit);
        \$conditions += 1;
    }
    if (\$limit !== null) \$page = \$conditions === 0 ? \$page->ltSeq(\$limit) : \$page->andLtSeq(\$limit);
    return \$page;
}
PHP;
        [$code, $err, $dir] = self::generate('reassigned-variable', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
        foreach (['gtReadCount', 'andGtReadCount', 'ltSeq', 'andLtSeq'] as $method) {
            self::assertContains(
                $method,
                self::tags($dir, 'Author'),
                "Author lacks $method called on a reassigned variable"
            );
        }
    }

    // Requirements: DSL-44.
    public function testARelationToAnEntityOfAUsedDocumentAttachesItsGetter(): void
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

    // Requirements: DBS-173.
    public function testAUsedExternalTableThatNoSourceCallsKeepsItsModel(): void
    {
        // note.dbs uses ext_session of core.dbs, and its own table ext_note has no foreign key to it; the source calls
        // ExtNote only, so the model of ExtSession is written anyway.
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\\ExtNote;

\$rows = (new ExtNote())->connect(\$db)->get();
PHP;
        $owned = "dbspec 1 ext_note\n\nuse ext_core { ext_session }\n\ntable ext_note {\n  seq i64 identity\n  title "
            . "varchar(191)\n  primary key (seq)\n}\n";
        [$code, $err, $dir] = self::generateExternal('external-unused-models', ['usage.php' => $source], $owned);
        self::assertSame(0, $code, $err);
        self::assertFileExists("$dir/model/ExtSession.php");
    }

    // Requirements: DSL-151.
    public function testANameIsTypedByItsBindingInItsOwnScope(): void
    {
        // The outer row is a ServiceMember. A destructuring assignment and an if with differing branches leave row with
        // a class the scan cannot type, so their setIsClose calls are not the outer ServiceMember's; the call on an
        // Author row in another function is attributed to Author.
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

    public function testANameThatMayHoldTwoModelsGetsTheCallOnEach(): void
    {
        // Each branch binds row to another model, so the call after the if is on either: each class declares the
        // method.
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

    public function testAReferenceForgetsBothNames(): void
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

    /**
     * A getter on a name that may hold two models is refused only when no possible class has it: Author has is_close,
     * User does not.
     */
    public function testAPossibleClassWithTheGetterAcceptsTheCallAfterAnIf(): void
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
        [$code, $err] = self::generate(
            'a_possible_class_with_the_getter_accepts_the_call_after_an_if',
            ['usage.php' => $source]
        );
        self::assertSame(0, $code, $err);
    }

    public function testAPossibleClassWithTheGetterAcceptsTheCallInALoop(): void
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
        [$code, $err] = self::generate(
            'a_possible_class_with_the_getter_accepts_the_call_in_a_loop',
            ['usage.php' => $source]
        );
        self::assertSame(0, $code, $err);
    }

    public function testABranchThatReturnsContributesNothing(): void
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

    public function testALoopThatMayRunZeroTimesKeepsTheClassBeforeIt(): void
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
        [$code, $err] = self::generate(
            'a_loop_that_may_run_zero_times_keeps_the_class_before_it',
            ['usage.php' => $source]
        );
        self::assertSame(0, $code, $err);
    }

    public function testANullAssignmentContributesNothing(): void
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

    public function testAReferenceInALoopForgetsBothNamesAtItsEntry(): void
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
        [$code, $err] = self::generate(
            'a_reference_in_a_loop_forgets_both_names_at_its_entry',
            ['usage.php' => $source]
        );
        self::assertSame(0, $code, $err);
    }

    /**
     * A model method is refused only when no possible class declares it: Author has is_close, ServiceMember does not.
     */
    public function testAMethodIsRefusedOnlyWhenNoPossibleClassDeclaresIt(): void
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
        $try = OrmGenTestSupport::phpSource(
            [self::NS . '\Author', self::NS . '\ServiceMember'],
            "function attempts(): void
{
"
                . OrmGenTestSupport::phpTryCatch(
                    '$row = new Author();',
                    '$row = new ServiceMember();'
                )
                . "    \$row->neIsClose(true);
}
",
            'App'
        );
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
    public function testATryLeavesNoOutcomeWithTheValueBeforeIt(): void
    {
        $source = OrmGenTestSupport::phpSource(
            [self::NS . '\Author', self::NS . '\ServiceMember'],
            "function attempts(): void
{
"
                . "    \$row = new Author();
"
                . OrmGenTestSupport::phpTryCatch(
                    '$row = new ServiceMember();',
                    '$row = new ServiceMember();'
                )
                . "    \$row->neIsClose(true);
}
",
            'App'
        );
        [$code, $err] = self::generate('try-no-base', ['usage.php' => $source]);
        self::assertSame(1, $code, 'status');
        self::assertStringContainsString('ServiceMember.neIsClose is not a model method', $err);
    }

    /**
     * Generates the models of shapes.dbs, whose alpha and beta tables share the name flag with a boolean and a datetime
     * column, with
     * --scan of $source in a new folder; returns the code, stderr and the folder.
     */
    private static function generateShapes(string $name, string $source): array
    {
        $dir = self::$work . '/' . $name;
        is_dir("$dir/set") || mkdir("$dir/set", 0o700, true);
        is_dir("$dir/src") || mkdir("$dir/src", 0o700, true);
        file_put_contents(
            "$dir/set/shapes.dbs",
            "dbspec 1 shapes\n\ntable alpha {\n  seq i64 identity\n  flag bool\n  primary key (seq)\n}\n\ntable beta "
            . "{\n  seq i64 identity\n  flag datetime(6)\n  primary key (seq)\n}\n"
        );
        $set = OrmGenTestSupport::setFile("$dir/set", ['shapes.dbs'], null);
        file_put_contents("$dir/src/usage.php", $source);
        [$code, $stderr] = self::runScan($set, "$dir/model", ['--scan', "$dir/src/usage.php"]);
        return [$code, $stderr, $dir];
    }

    /**
     * An argument count is accepted when one class that may hold the name accepts it, and refused when no possible
     * class does.
     */
    public function testAnArgumentCountIsRefusedOnlyWhenNoPossibleClassAcceptsIt(): void
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
        // Alpha takes one argument and Beta takes two (its datetime column takes the optional comparison): two
        // arguments are accepted.
        [$code, $err] = self::generateShapes('count-one-accepts', $source);
        self::assertSame(0, $code, $err);
        // No class takes three arguments, so the call is refused, naming the class that declares the method.
        [$code, $err] = self::generateShapes(
            'count-none-accepts',
            str_replace('neFlag(true, false)', 'neFlag(true, false, true)', $source)
        );
        self::assertSame(1, $code, 'status');
        self::assertStringContainsString('Alpha.neFlag takes 1 argument, called with 3', $err);
    }

    /** A zero-iteration foreach keeps the value the name had before the loop, so the call is on Author or User. */
    public function testAZeroIterationForeachKeepsTheValueBeforeIt(): void
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
    public function testAParameterNamedLikeAnOuterModelIsNotThatModel(): void
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

    public function testARestoreOrCreateCallIsAModelMethod(): void
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

    public function testADirectoryIsScannedAndAFileThatDoesNotParseFailsTheScan(): void
    {
        // The test of DSL-42 (docs/spec).
        $dir = self::$work . '/directory';
        is_dir("$dir/src/nested") || mkdir("$dir/src/nested", 0o700, true);
        file_put_contents("$dir/src/nested/a.php", "<?php\n\$a = new " . self::NS . "\\Author();\n\$a->ltSeq(1);\n");
        file_put_contents("$dir/src/notes.txt", "ltIgnored(");
        [$code, $err] = self::runScanDirectory($dir, "$dir/model");
        self::assertSame(0, $code, $err);
        self::assertSame(['ltSeq'], self::tags($dir, 'Author'));
        file_put_contents("$dir/src/broken.php", "<?php\n\$a = new (;\n");
        [$code, $err] = self::runScanDirectory($dir, "$dir/model2");
        self::assertSame(1, $code);
        self::assertStringContainsString('broken.php', $err);
    }

    public function testAScannedDirectorySkipsItsDependenciesAndRefusesASymlink(): void
    {
        // The test of DSL-42 (docs/spec).
        $dir = self::$work . '/links';
        mkdir("$dir/src/vendor/pkg", 0o700, true);
        file_put_contents("$dir/src/a.php", "<?php\n\$a = new " . self::NS . "\\Author();\n\$a->ltSeq(1);\n");
        file_put_contents(
            "$dir/src/vendor/pkg/b.php",
            "<?php\n\$a = new " . self::NS . "\\Author();\n\$a->gtSeq(1);\n"
        );
        [$code, $err] = self::runScanDirectory($dir, "$dir/model");
        self::assertSame(0, $code, $err);
        self::assertSame(['ltSeq'], self::tags($dir, 'Author'));
        mkdir("$dir/elsewhere", 0o700, true);
        file_put_contents("$dir/elsewhere/c.php", "<?php\n\$a = new " . self::NS . "\\Author();\n\$a->geSeq(1);\n");
        symlink("$dir/elsewhere", "$dir/src/linked");
        [$code, $err] = self::runScanDirectory($dir, "$dir/model2");
        self::assertSame(1, $code);
        self::assertStringContainsString("$dir/src/linked is a symlink", $err);
    }

    public function testCheckComparesTheModelsWithTheScan(): void
    {
        $source = "<?php\n\$a = new " . self::NS . "\\Author();\n\$a->ltSeq(1);\n";
        [$code, $err, $dir] = self::generate('check', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
        $args = [
            'gen',
            '--set',
            dirname(__DIR__, 3) . '/contracts/fixtures/bench/dbspec-set.json',
            '--out',
            "$dir/model",
            '--namespace',
            self::NS,
            '--scan',
            "$dir/src/usage.php",
            '--check'
        ];
        [$code, $stdout] = OrmGenTestSupport::run($args);
        self::assertSame(0, $code, 'current');
        self::assertSame('', $stdout);
        file_put_contents("$dir/src/usage.php", $source . "\$a->gtSeq(1);\n");
        [$code, $stdout] = OrmGenTestSupport::run($args);
        self::assertSame(1, $code, 'stale');
        self::assertSame("differs: $dir/model/Author.php\n", $stdout);
    }

    public function testPhpstanFindsEveryScannedChainMethod(): void
    {
        // The test of DSL-42 (docs/spec).
        $root = dirname(__DIR__, 3);
        $ns = self::NS;
        $used = <<<PHP
<?php
declare(strict_types=1);

use $ns\\Author;
use $ns\\ServiceMember;
use $ns\\User;

function calls(Author \$a, User \$u, Polyspec\\Orm\\Db \$db): Author
{
    \$a->ltSeq(1)->andGeReadCount(2)->orNeIsClose(true)->lkName('n')->seqAndName(1, 'a')->betweenReadCount([1, 5]);
    \$a->gtStartDt(\\Polyspec\\Orm\\Func::class === '' ? new DateTimeImmutable() : new DateTimeImmutable());
    \$a->getsBySeqAndIsClose(1, false);
    \$a->orderBySeqDescAndNameAsc()->joinUserSeqWithSeq(\$u)->tupleUserSeqWithServiceSeq([[1, 2]]);
    \$a->aliasMine()->newExtra(1)->possibleSeq(1);
    \$a->getServiceMemberModels();
    \$a->getUserModel();
    \$a->relations((new ServiceMember())->matchServiceSeqWithServiceSeq()->aliasMembers())->get()?->getMembers();
    \$a->relation((new User())->matchUserSeqWithSeq()->aliasWriter())->gets()->first()?->getWriter();
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
            . "    if (str_starts_with(\$class, \$prefix)) {\n        require " . var_export(
                "$dir/model/",
                true
            ) . " . substr(\$class, strlen(\$prefix)) . '.php';\n    }\n});\n");
        file_put_contents(
            "$dir/autoload.php",
            "<?php\nrequire " . var_export(
                "$root/packages/php/tests/autoload.php",
                true
            ) . ";\nrequire " . var_export("$dir/models.php", true) . ";\n"
        );
        file_put_contents("$dir/phpstan.neon", "parameters:\n    tmpDir: $dir/phpstan-cache\n");
        // A call that the sources of the scan do not make is not declared: the control that makes the zero meaningful.
        file_put_contents(
            "$dir/control.php",
            "<?php\ndeclare(strict_types=1);\n\nfunction "
            . "control(\\$ns\\Author \$a): void\n{\n    \$a->ltReadCount(1);\n}\n"
        );
        $analyse = function (string $file) use ($root, $dir): array {
            [$status, $out, $err] = runPhpstan(
                $this,
                $root,
                "$dir/phpstan.neon",
                "$dir/autoload.php",
                $file,
                'json'
            );
            // PHPStan exits 0 without errors and 1 with errors; any other status is a run that did not analyse.
            self::assertContains($status, [0, 1], "phpstan analyse $file exited with $status:\n$out$err");
            // The JSON report names the identifier of each error (files.<path>.messages[].identifier), so a finding is
            // matched by its identifier, not by the text of a format.
            $report = json_decode($out, true, flags: JSON_THROW_ON_ERROR);
            self::assertIsArray($report, "phpstan analyse $file wrote no JSON report:\n$out$err");
            $findings = [];
            foreach ((array) ($report['files'] ?? []) as $path => $entry) {
                foreach ((array) (is_array($entry) ? ($entry['messages'] ?? []) : []) as $message) {
                    self::assertIsArray(
                        $message,
                        "phpstan analyse $file reported a message that is not an object:\n$out"
                    );
                    $findings[] = sprintf(
                        '%s:%s: %s [%s]',
                        $path,
                        $message['line'] ?? '?',
                        $message['message'] ?? '',
                        $message['identifier'] ?? 'no identifier'
                    );
                }
            }
            return [$findings, $out . $err, $status];
        };
        $consumer = <<<PHP
<?php
declare(strict_types=1);

use {$ns}\\Author;
use {$ns}\\ServiceMember;
use {$ns}\\User;

function canonicalMember(Author \$author): ServiceMember
{
    return \$author->getServiceMemberModels()->get(1) ?? throw new RuntimeException();
}

function aliasedMember(Author \$author): ServiceMember
{
    return \$author->getMembers()->get(1) ?? throw new RuntimeException();
}

function nullableCanonicalUser(Author \$author): ?User
{
    return \$author->getUserModel();
}

function nullableAliasedUser(Author \$author): ?User
{
    return \$author->getWriter();
}
PHP;
        file_put_contents("$dir/relation-consumer.php", $consumer);
        [$findings, $raw] = $analyse("$dir/src/usage.php");
        $notFound = array_values(
            array_filter($findings, static fn(string $line): bool => str_ends_with($line, '[method.notFound]'))
        );
        self::assertSame([], $notFound, "method.notFound:\n" . implode("\n", $notFound) . "\n$raw");
        [$relationFindings, $relationRaw, $relationStatus] = $analyse("$dir/relation-consumer.php");
        self::assertSame(0, $relationStatus, "relation getter types:\n$relationRaw");
        self::assertSame([], $relationFindings, "relation getter types:\n$relationRaw");
        [$control, $controlRaw, $controlStatus] = $analyse("$dir/control.php");
        self::assertSame(1, $controlStatus, "the control call is declared:\n$controlRaw");
        self::assertNotSame(
            [],
            array_filter($control, static fn(string $line): bool => str_ends_with($line, '[method.notFound]')),
            "the control call is declared:\n$controlRaw"
        );
    }
}
