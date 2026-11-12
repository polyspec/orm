<?php

declare(strict_types=0);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Model;

function modelWeakLimit(Model $model, mixed $offset, mixed $count): Model
{
    return $model->limit($offset, $count);
}

function modelWeakGroupLimit(Model $model, mixed $count): Model
{
    return $model->groupLimit($count);
}

function modelWeakExpectRevision(Model $model, mixed $column, mixed $revision): Model
{
    return $model->expectRevision($column, $revision);
}

function modelWeakGetsPage(Model $model, mixed $page, mixed $perPage): mixed
{
    return $model->getsPage($page, $perPage);
}

function modelWeakCreates(Model $model, array $rows, mixed $batch): mixed
{
    return $model->creates($rows, $batch);
}

function modelWeakUpdate(Model $model, mixed $optimistic = false): Model
{
    return $model->update($optimistic);
}

function modelWeakDelete(Model $model, mixed $recursive = false): void
{
    $model->delete($recursive);
}

function modelWeakDeleteRow(Model $model, mixed $recursive): void
{
    $model->deleteRow($recursive);
}

function modelWeakCall(Model $model, mixed $name, mixed $args): mixed
{
    return $model->__call($name, $args);
}
