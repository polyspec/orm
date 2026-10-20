<?php

declare(strict_types=1);

namespace Polyspec\Orm;

use Polyspec\Orm\Dbspec\CatalogRows;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\DocumentSet;
use Polyspec\Orm\Dbspec\Renderer;

/** Table privileges (PostgreSQL only). */
final class PrivilegeUtils
{
    public function __construct(private readonly Db $db, private readonly Utils $u)
    {
    }

    private function table(string $table): string
    {
        if ($this->db->driver() !== 'postgres') {
            throw new OrmException(Code::CAPABILITY_UNSUPPORTED, 'table privileges are supported only by postgres');
        }
        $parts = explode('.', $table);
        if (count($parts) !== 2 || preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $parts[0]) !== 1
            || preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $parts[1]) !== 1) {
            throw new OrmException(Code::CONFIG, 'a qualified table name is required');
        }
        return '"' . $parts[0] . '"."' . $parts[1] . '"';
    }

    private static function role(string $role): string
    {
        if (preg_match('/^[A-Za-z_][A-Za-z0-9_.]*$/', $role) !== 1) {
            throw new OrmException(Code::CONFIG, "role $role is invalid");
        }
        return '"' . $role . '"';
    }

    public function grantTable(string $table, string $role): void
    {
        $qualified = $this->table($table);
        $r = self::role($role);
        $schema = substr($qualified, 0, (int) strpos($qualified, '.'));
        $this->u->run(function () use ($table, $qualified, $r, $schema): void {
            $this->u->exec(StatementEvent::UTILITY, [$table], "GRANT USAGE ON SCHEMA $schema TO $r");
            $this->u->exec(StatementEvent::UTILITY, [$table],
                "GRANT SELECT, INSERT, UPDATE, DELETE ON $qualified TO $r");
        });
    }

    public function revokeTable(string $table, string $privilege, string $role): void
    {
        $qualified = $this->table($table);
        $r = self::role($role);
        $privilege = strtoupper(trim($privilege));
        if (!in_array($privilege, ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'], true)) {
            throw new OrmException(Code::CONFIG, "unsupported table privilege $privilege");
        }
        $this->u->run(fn() => $this->u->exec(StatementEvent::UTILITY, [$table],
            "REVOKE $privilege ON $qualified FROM $r"));
    }

    /** @return array{insert: bool, select: bool, update: bool, delete: bool, truncate: bool} */
    public function inspectTable(string $table): array
    {
        $qualified = $this->table($table);
        // Reads the five privileges in one statement. Every client runs the same statement.
        $row = $this->db->fetch(StatementEvent::UTILITY, [$table], $this->db->transactionNumber(),
            "SELECT has_table_privilege(current_user, $1, 'INSERT'), has_table_privilege(current_user, $1, 'SELECT'), has_table_privilege(current_user, $1, 'UPDATE'), has_table_privilege(current_user, $1, 'DELETE'), has_table_privilege(current_user, $1, 'TRUNCATE')",
            [$qualified])[0];
        $out = [];
        foreach (['insert', 'select', 'update', 'delete', 'truncate'] as $i => $p) {
            $out[$p] = (bool) $row[$i];
        }
        return $out;
    }
}
