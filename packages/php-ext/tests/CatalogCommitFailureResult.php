<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

final class CatalogCommitFailureResult extends \mysqli_result
{
    private bool $fetched = false;

    public function __construct()
    {
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- mysqli dispatch requires this exact API method name.
    public function fetch_fields(): array
    {
        return [(object) ['name' => 'value', 'type' => MYSQLI_TYPE_LONG, 'flags' => 0, 'charsetnr' => 63]];
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- mysqli dispatch requires this exact API method name.
    public function fetch_row(): array|null|false
    {
        if ($this->fetched) {
            return null;
        }
        $this->fetched = true;
        return [1];
    }
}
