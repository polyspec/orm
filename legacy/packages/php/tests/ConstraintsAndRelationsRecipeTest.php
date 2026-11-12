<?php

// Requirements: CFG-33, INT-87, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14.
// The constraints and relations recipe, contracts/fixtures/constraints_and_relations/constraints_and_relations.json, on
// each database (docs/spec/feature-coverage.md FCV-3 and FCV-4): the generated Author, User, NoteReader and SharedNote
// models of the bench set.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class ConstraintsAndRelationsRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/constraints_and_relations/constraints_and_relations.json';
    }
}
