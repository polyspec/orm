<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Model;

final class ModelAssemblyFixture extends Model
{
    public static function meta(): array
    {
        return ['entity' => 'model_assembly_fixture'];
    }
}
