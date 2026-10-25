<!-- doc-id: rebuild-php-sqlite-cancellation -->
# PHP SQLite cancellation

`Pdo\Sqlite::loadExtension()` loads a small SQLite loadable extension that installs
`sqlite3_progress_handler()` on the PDO connection. PDO exposes no progress-handler
or interrupt method. The handler reads the one-byte cancellation state file while
SQLite executes virtual-machine instructions and returns `SQLITE_INTERRUPT` only
while the token is both active and cancelled. PHP creates the state file with mode
0600 and removes it when its owning process releases the token. The runtime loads
the extension through the public PDO API; it never compiles native code while a
request is running.

The Composer archive includes `bin/orm-sqlite-cancel-build.php` and the C source.
After installing the PHP package, a consumer builds the helper explicitly with
`vendor/bin/orm-sqlite-cancel-build.php`. `make php-cancel-helper-build` runs the same
builder in this checkout. The command uses the platform C compiler, `pkg-config`, and
the SQLite development headers already used to build SQLite on that platform. It
publishes the helper atomically at
`src/native/bin/<os>-<architecture>/orm_cancel` inside the installed package, with the
platform suffix. PHP looks up the installed package with `Composer\InstalledVersions`
and loads that completed artifact. The builder compiles beside the destination, sets
its private file mode, then renames it into place; the helper remains installed until
the package is removed or rebuilt. Installing or upgrading the Composer package
requires rerunning the explicit build command. The PHP unit case executes a recursive
SQLite statement whose collation callback cancels the source while the statement is
running, checks `CANCELED`, checks transaction rollback, and reuses the root PDO
connection. MySQL and PostgreSQL use their protocol control connections to terminate
the active server connection and reconnect the root handle.

The PHP API and driver searches found no public PDO operation that registers a
SQLite progress callback or interrupts the PDO SQLite virtual machine. An application
callback that throws only unwinds PHP and does not stop a statement executing inside
SQLite. The public SQLite loadable-extension API is therefore the selected integration
point; no PDO internal structures are accessed.
