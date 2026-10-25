<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Engine;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use PHPUnit\Framework\Assert;

trait BlindIndexSourcePlannerInput
{
    private const SCHEMA = <<<'DBSPEC'
dbspec 1 shared
table t {
  id i64
  version i32
  name varchar(191)
  email_a bytes null
  email_b bytes null
  hash varchar(64) null
  primary key (id)
  index ix_t_hash (hash)
  settings {
    codec email_a aes
    codec email_b aes
    aes_version version
    blind_index email_a hash
    blind_index email_b hash
  }
}
DBSPEC;

    private function engine(): Engine
    {
        $model = RuntimeModel::build(RuntimeModel::parse(['shared.dbs' => self::SCHEMA]));
        return new Engine($model, 'mysql', 8);
    }

    private function request(Engine $engine, array $set, int $nParams, array $extra = []): array
    {
        return ['manifest_hash' => $engine->model->manifestHash] + [
            'ir_version' => 1,
            'kind' => 'insert',
            'entity' => 't',
            'n_params' => $nParams,
            'set' => $set,
        ] + $extra;
    }

    private function assignment(string $column, int $p): array
    {
        return ['column' => $column, 'p' => $p];
    }

    private function assertSourceConflict(Engine $engine, array $request): void
    {
        try {
            $engine->compile($request);
        } catch (OrmException $error) {
            Assert::assertSame('IR_INVALID', $error->code_);
            foreach (['hash', 'email_a', 'email_b'] as $name) {
                Assert::assertStringContainsString($name, $error->getMessage());
            }
            return;
        }
        Assert::fail('expected IR_INVALID naming the conflicting target and both assigned sources');
    }

    /** @param list<array{column: string, p?: int, null?: bool}> $sources */
    private function assertSourcesConflict(array $sources, int $nParams): void
    {
        $engine = $this->engine();
        $request = $this->request($engine, [
            $this->assignment('id', 0),
            $this->assignment('name', 1),
            ...$sources,
        ], $nParams);
        $this->assertSourceConflict($engine, $request);
    }

    private function compileInsert(array $assignments, int $nParams, array $extra = []): array
    {
        $engine = $this->engine();
        return $engine->compile($this->request($engine, $assignments, $nParams, $extra));
    }

    private function compileBaseInsert(int $nParams, array $extra = []): array
    {
        return $this->compileInsert([
            $this->assignment('id', 0),
            $this->assignment('name', 1),
        ], $nParams, $extra);
    }

    /** A multi-row insert binds the blind index of each row from the position of its assigned source column. */
    private function assertMultiRowIndexUsesTheAssignedSourcePosition(): void
    {
        $plan = $this->compileInsert([
            $this->assignment('id', 0),
            $this->assignment('name', 1),
            $this->assignment('email_b', 2),
        ], 6, ['rows' => [[3, 4, 5]]]);
        $params = [];
        foreach ($plan['steps'][0]['bind_slots'] as $slot) {
            if (in_array('blind_index', $slot['host_styles'] ?? [], true)) {
                $params[] = $slot['param'];
            }
        }
        Assert::assertSame([2, 5], $params);
    }

    /** An insert that assigns no blind index source binds no blind index. */
    private function assertOrdinaryInsertHasNoBlindIndexSlots(): void
    {
        $plan = $this->compileBaseInsert(2);
        foreach ($plan['steps'][0]['bind_slots'] as $slot) {
            Assert::assertNotContains('blind_index', $slot['host_styles'] ?? []);
        }
    }

    /** An explicit assignment of the shared target wins over its sources: the target column is written once. */
    private function assertExplicitTargetAssignmentWins(): void
    {
        $plan = $this->compileInsert([
            $this->assignment('id', 0),
            $this->assignment('name', 1),
            $this->assignment('email_a', 2),
            $this->assignment('email_b', 3),
            $this->assignment('hash', 4),
        ], 5);
        Assert::assertSame(1, substr_count($plan['steps'][0]['sql'], '`hash`'));
    }

    /** The on-duplicate assignments refuse two sources of one target by themselves, for each kind of conflict. */
    private function assertOnDuplicateRejectsTwoSourcesIndependently(): void
    {
        $engine = $this->engine();
        $cases = [
            [[$this->assignment('email_a', 2), $this->assignment('email_b', 3)], 4],
            [[$this->assignment('email_a', 2), $this->assignment('email_b', 2)], 3],
            [[['column' => 'email_a', 'null' => true], ['column' => 'email_b', 'null' => true]], 2],
        ];
        foreach ($cases as [$onDuplicate, $nParams]) {
            $request = $this->request($engine, [$this->assignment('id', 0), $this->assignment('name', 1)], $nParams, [
                'on_duplicate' => $onDuplicate,
            ]);
            $this->assertSourceConflict($engine, $request);
        }
    }

    /** An explicit target in the on-duplicate assignments wins over its sources: the target column is written once. */
    private function assertExplicitTargetWinsInOnDuplicate(): void
    {
        $plan = $this->compileBaseInsert(5, [
            'on_duplicate' => [
                $this->assignment('email_a', 2),
                $this->assignment('email_b', 3),
                $this->assignment('hash', 4),
            ],
        ]);
        Assert::assertSame(1, substr_count($plan['steps'][0]['sql'], '`hash`'));
    }
}
