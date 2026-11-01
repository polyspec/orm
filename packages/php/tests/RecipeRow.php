<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Model;
use Polyspec\Orm\Registry;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Schema;
use RuntimeException;

/**
 * The model of a table of the statement events fixture (the model ops of the recipe). The fixture has no generated
 * class here: the entity that RuntimeModel gives the table is the meta of this class, and a column is written through
 * the column access that every generated setter calls (writeColumn). The recipe runs one table at a time, so the step
 * names it first.
 */
final class RecipeRow extends Model
{
    /** @var array<string, mixed> the entity of the table that the current step names */
    private static array $entity = [];

    public static function bindTable(string $table, Schema $schema): void
    {
        $set = RuntimeModel::loadSet($schema->manifestText, $schema->externalText);
        $entity = RuntimeModel::build($set)->entity($table);
        if ($entity === null) {
            throw new RuntimeException("the fixture has no entity $table");
        }
        self::$entity = $entity + ['manifest_hash' => $schema->manifestHash];
        // The generated bootstrap registers the set and then each class (Registry::generated, Registry::register); the
        // class registers for its entity in the same way, so a model of it plans its requests.
        if (!Registry::loaded($schema->manifestHash)) {
            Registry::generated($schema->manifestHash, $schema->manifestText, $schema->externalText);
        }
        Registry::register(self::class);
    }

    public static function meta(): array
    {
        return self::$entity;
    }

    public function setColumn(string $column, mixed $value): static
    {
        return $this->writeColumn($column, $value);
    }
}
