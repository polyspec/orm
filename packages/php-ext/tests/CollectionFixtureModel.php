<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Collection;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;

class CollectionFixtureModel extends Model
{
    public ?Collection $collectionCycle = null;
    public ?Db $connectedTo = null;
    public array $deleted = [];

    public function __construct(public string $label)
    {
    }

    public static function meta(): array
    {
        return [];
    }

    public function toArray(): array
    {
        return ['label' => $this->label];
    }

    public function toJson(): string
    {
        return json_encode($this->toArray(), JSON_THROW_ON_ERROR);
    }

    public function connect(Db $db): static
    {
        parent::connect($db);
        $this->connectedTo = $db;
        return $this;
    }

    public function deleteRow(bool $recursive): void
    {
        $this->deleted[] = $recursive;
    }
}
