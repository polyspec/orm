<?php
// make ci-php-sqlite: every client requires SQLite 3.46, and PHP links the system SQLite of the runner. The PHP that
// runs this script prints the SQLite it links and fails below 3.46.
declare(strict_types=1);
$version = (string) (new PDO('sqlite::memory:'))->query('select sqlite_version()')->fetchColumn();
echo "PHP SQLite $version\n";
exit(version_compare($version, '3.46', '<') ? 1 : 0);
