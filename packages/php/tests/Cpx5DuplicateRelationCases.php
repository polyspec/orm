<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\User;

trait Cpx5DuplicateRelationCases
{
    protected function assertDuplicateRelationAliasHint(string $temporaryPrefix): void
    {
        $path = tempnam(sys_get_temp_dir(), $temporaryPrefix);
        Assert::assertNotFalse($path);
        $db = null;
        try {
            $db = Model\connect('sqlite://' . $path, new Config());
            $query = (new Author())->connect($db)
                ->relation((new User())->matchUserSeqWithSeq())
                ->relation((new User())->matchUserSeqWithSeq());
            try {
                $query->getQuery();
                Assert::fail('duplicate relation result name was accepted');
            } catch (OrmException $error) {
                Assert::assertSame(Code::CONFIG, $error->code_);
                Assert::assertStringContainsString('user_model', $error->getMessage());
                Assert::assertStringContainsString('alias<Name>()', $error->getMessage());
            }
        } finally {
            $db?->close();
            unlink($path);
        }
    }
}
