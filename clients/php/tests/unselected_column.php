<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Polyspec\Orm\Tests\Model\Author;
use Orm\Code;
use Orm\OrmException;

function expectUnselected(callable $read, string $column): void
{
    try {
        $read();
    } catch (OrmException $error) {
        if ($error->code_ === Code::COLUMN_UNSELECTED) return;
        throw $error;
    }
    throw new RuntimeException("unselected $column returned a value");
}

$model = new Author();
expectUnselected(static fn() => $model->getSeq(), 'integer');
expectUnselected(static fn() => $model->getIsClose(), 'boolean');
expectUnselected(static fn() => $model->getDescription(), 'nullable text');
expectUnselected(static fn() => $model->getCreatedTs(), 'date');
expectUnselected(static fn() => $model->getPrice(), 'nullable decimal');
$model->setName('assigned')->setDescription(null);
if ($model->getName() !== 'assigned' || $model->getDescription() !== null) {
    throw new RuntimeException('assigned value changed');
}
echo "PHP unselected-column owner cases passed\n";
