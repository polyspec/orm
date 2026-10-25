<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

final class RuntimeModelGeneratedFixture
{
    public static function meta(): array
    {
        return [
            'entity' => 'account', 'table' => 'users', 'pk' => ['id'], 'identity' => 'id',
            'updated' => '', 'soft_delete' => '', 'aes_version' => '', 'audit' => '', 'audit_record' => '',
            'columns' => [
                'id' => [
                    'name' => 'id',
                    'type' => 'i64',
                    'nullable' => false,
                    'default' => false,
                    'default_now' => false,
                    'select' => true,
                    'codec' => [],
                    'blind_index' => '',
                    'pk' => true,
                    'foreign_key' => false,
                ],
                'title' => [
                    'name' => 'title',
                    'type' => 'varchar',
                    'nullable' => false,
                    'default' => false,
                    'default_now' => false,
                    'select' => false,
                    'codec' => [],
                    'blind_index' => '',
                    'pk' => false,
                    'foreign_key' => false,
                    'length' => 64,
                ],
                'amount' => [
                    'name' => 'amount',
                    'type' => 'decimal',
                    'nullable' => true,
                    'default' => true,
                    'default_now' => false,
                    'select' => true,
                    'codec' => [],
                    'blind_index' => '',
                    'pk' => false,
                    'foreign_key' => false,
                    'precision' => 12,
                    'scale' => 2,
                ],
            ],
            'unique' => ['uq_title' => ['title']], 'indexes' => ['ix_title' => ['title']],
            'manifest_hash' => 'sha256:generated-fixture',
        ];
    }
}
