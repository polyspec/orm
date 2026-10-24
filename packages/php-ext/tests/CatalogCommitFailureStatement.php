<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

final class CatalogCommitFailureStatement extends \mysqli_stmt
{
    public function __construct()
    {
    }

    public function execute(?array $params = null): bool
    {
        return true;
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- mysqli dispatch requires this exact API method name.
    public function get_result(): \mysqli_result|false
    {
        return new CatalogCommitFailureResult();
    }
}
