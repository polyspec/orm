<?php

declare(strict_types=1);

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Tests\Model\Author;

#[Small]
final class UnselectedColumnTest extends TestCase
{
    private static function assertUnselected(callable $read, string $column): void
    {
        try {
            $read();
        } catch (OrmException $error) {
            self::assertSame(Code::COLUMN_UNSELECTED, $error->code_, "unselected $column");
            return;
        }
        self::fail("unselected $column returned a value");
    }

    public function test_owner(): void
    {
        $model = new Author();
        self::assertUnselected(static fn() => $model->getSeq(), 'integer');
        self::assertUnselected(static fn() => $model->getIsClose(), 'boolean');
        self::assertUnselected(static fn() => $model->getDescription(), 'nullable text');
        self::assertUnselected(static fn() => $model->getCreatedTs(), 'date');
        self::assertUnselected(static fn() => $model->getPrice(), 'nullable decimal');
        $model->setName('assigned')->setDescription(null);
        self::assertSame('assigned', $model->getName(), 'assigned value changed');
        self::assertNull($model->getDescription(), 'assigned value changed');
    }
}
