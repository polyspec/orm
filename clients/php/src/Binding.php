<?php
declare(strict_types=1);

namespace Orm;

/** Binding owns one executor reference; the request never contains it. */
final class Binding
{
    public function __construct(private readonly ?Db $executor = null) {}

    public function resolve(): Db
    {
        $ex = $this->executor ?? throw new OrmException(Code::CONFIG, 'bind a database or transaction before executing');
        if ($ex instanceof Tx) { $ex->assertActive(); }
        return $ex;
    }
}
