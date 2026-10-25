<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use LogicException;

/** The generated documents of a limit case and the one diagnostic each must give: [text, [rule, line, column]]. */
function rules_limit(string $id): array
{
    switch ($id) {
        case 'size':
            return [str_pad("dbspec 1 shop\n", 32 * 1024 * 1024 + 1, "\n"), ['limit', 1, 1]];
        case 'tables':
            $tables = "dbspec 1 shop\n";
            for ($i = 0; $i < 4097; $i++) {
                $tables .= "\ntable t$i {\n  id i64 identity\n  primary key (id)\n}\n";
            }
            return [$tables, ['limit', 3 + 4096 * 5, 1]];
        case 'table-columns':
            $columns = "dbspec 1 shop\n\ntable t {\n";
            for ($i = 0; $i < 1001; $i++) {
                $columns .= "  c$i i64\n";
            }
            $columns .= "  primary key (c0)\n}\n";
            return [$columns, ['limit', 4 + 1000, 3]];
        case 'columns':
            $all = "dbspec 1 shop\n";
            for ($t = 0; $t < 121; $t++) {
                $all .= "\ntable t$t {\n";
                for ($i = 0; $i < 1000; $i++) {
                    $all .= "  c$i i64\n";
                }
                $all .= "  primary key (c0)\n}\n";
            }
            // Column 120001 is the first column of table 121 (index 120).
            return [$all, ['limit', 4 + 120 * 1004, 3]];
        case 'foreign-keys':
            $fks = "dbspec 1 shop\n";
            $line = 1;
            $fkLine = 0;
            for ($t = 0; $t < 21; $t++) {
                $fks .= "\ntable t$t {\n  id i64 identity\n  primary key (id)\n";
                $line += 4;
                for ($i = 0; $i < 1000; $i++) {
                    $fks .= "  foreign key fk_{$t}_$i (id) references t$t (id)\n";
                    $line++;
                    if ($t === 20 && $i === 0) {
                        $fkLine = $line;
                    }
                }
                $fks .= "}\n";
                $line++;
            }
            return [$fks, ['limit', $fkLine, 3]];
    }
    throw new LogicException("unknown limit case $id");
}
