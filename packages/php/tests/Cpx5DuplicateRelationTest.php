<?php
declare(strict_types=1);
namespace Polyspec\Orm\Tests;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\User;
final class Cpx5DuplicateRelationTest extends TestCase
{
    // Requirements: CPX-5.
    public function testGetQueryRejectsDuplicateRelationWithAliasHint(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-cpx5-');
        self::assertNotFalse($path);
        $db = null;
        try {
            $db = \Polyspec\Orm\Tests\Model\connect('sqlite://' . $path, new Config());
            $query = (new Author())->connect($db)
                ->relation((new User())->matchUserSeqWithSeq())
                ->relation((new User())->matchUserSeqWithSeq());
            try {
                $query->getQuery();
                self::fail('duplicate relation result name was accepted');
            } catch (OrmException $error) {
                self::assertSame(Code::CONFIG, $error->code_);
                self::assertStringContainsString('user_model', $error->getMessage());
                self::assertStringContainsString('alias<Name>()', $error->getMessage());
            }
        } finally {
            $db?->close();
            unlink($path);
        }
    }
}
