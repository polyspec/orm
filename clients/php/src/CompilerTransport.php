<?php
declare(strict_types=1);

namespace Orm;

use Orm\Compiler\V1\CompileRequest;
use Orm\Compiler\V1\GetMetadataResponse;
use Orm\Compiler\V1\Plan;

interface CompilerTransport
{
    public function compile(CompileRequest $request): Plan;
    public function metadata(): GetMetadataResponse;
}
