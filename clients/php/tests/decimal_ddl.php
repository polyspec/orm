<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\SchemaDdl;

$ddl = SchemaDdl::type(['type' => 'decimal', 'precision' => 13, 'scale' => 4], 'sqlite');
if ($ddl !== 'DECIMALINT(13,4)') {
    throw new RuntimeException("SQLite decimal DDL $ddl must use exact scaled storage");
}
echo "CASE sqlite_decimal_ddl PASS\n";
