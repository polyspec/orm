<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use ReflectionMethod;

trait PgsqlPdoAdapterCases
{
    /** Runs $body with a connection to a new PostgreSQL case database and its DSN; closed and dropped afterwards. */
    private static function onPostgresDb(\Closure $body): void
    {
        with_case_database(
            'postgres',
            static function (): void {
            },
            static function (string $dsn) use ($body): void {
                $db = Orm::connect($dsn, new Config());
                try {
                    $body($db, $dsn);
                } finally {
                    $db->close();
                }
            },
        );
    }

    /**
     * Each method of $methods is declared by the class of the PostgreSQL adapter $pdo, and is native when $native.
     *
     * @param list<string> $methods
     */
    private static function assertAdapterDeclares(object $pdo, array $methods, bool $native): void
    {
        foreach ($methods as $method) {
            $reflection = new ReflectionMethod($pdo, $method);
            self::assertSame(
                $pdo::class,
                $reflection->getDeclaringClass()->getName(),
                "$method is handled by the PostgreSQL adapter"
            );
            if ($native) {
                self::assertTrue($reflection->isInternal(), "$method is implemented by the native adapter");
            }
        }
    }

    protected function assertPdoPublicSurfaceIsOverridden(bool $native): void
    {
        self::onPostgresDb(static function (\Polyspec\Orm\Db $db) use ($native): void {
            $pdo = $db->pdo();
            $pdoClass = $pdo::class;
            $inherited = [];
            $nonInternal = [];
            $parents = [new \ReflectionClass(PDO::class), new \ReflectionClass(\Pdo\Pgsql::class)];
            foreach ($parents as $parent) {
                foreach ($parent->getMethods(ReflectionMethod::IS_PUBLIC) as $parentMethod) {
                    if (
                        $parentMethod->isStatic()
                        || $parentMethod->getDeclaringClass()->getName() !== $parent->getName()
                    ) {
                        continue;
                    }
                    $method = new ReflectionMethod($pdo, $parentMethod->getName());
                    if ($method->getDeclaringClass()->getName() !== $pdoClass) {
                        $inherited[] = 'PDO::' . $parentMethod->getName();
                    }
                    if ($native && !$method->isInternal()) {
                        $nonInternal[] = 'PDO::' . $parentMethod->getName();
                    }
                }
            }

            $statement = $pdo->prepare('SELECT 1');
            self::assertInstanceOf(\PDOStatement::class, $statement);
            $statementClass = $statement::class;
            $statementMethods = (new \ReflectionClass(\PDOStatement::class))->getMethods(
                ReflectionMethod::IS_PUBLIC
            );
            foreach ($statementMethods as $parentMethod) {
                if (
                    $parentMethod->isStatic()
                    || $parentMethod->getDeclaringClass()->getName() !== \PDOStatement::class
                ) {
                    continue;
                }
                $method = new ReflectionMethod($statement, $parentMethod->getName());
                if ($method->getDeclaringClass()->getName() !== $statementClass) {
                    $inherited[] = 'PDOStatement::' . $parentMethod->getName();
                }
                if ($native && !$method->isInternal()) {
                    $nonInternal[] = 'PDOStatement::' . $parentMethod->getName();
                }
            }

            foreach ([PDO::FETCH_NUM, PDO::FETCH_ASSOC] as $fetchMode) {
                $iterable = $pdo->query(
                    'SELECT 1::integer AS value UNION ALL SELECT 2::integer AS value'
                );
                self::assertInstanceOf(\PDOStatement::class, $iterable);
                self::assertTrue($iterable->setFetchMode($fetchMode));
                $rows = [];
                foreach ($iterable as $row) {
                    $rows[] = $row;
                    break;
                }
                $expectedFirst = $fetchMode === PDO::FETCH_NUM ? [1] : ['value' => 1];
                $expectedSecond = $fetchMode === PDO::FETCH_NUM ? [2] : ['value' => 2];
                self::assertSame([$expectedFirst], $rows);
                self::assertSame($expectedSecond, $iterable->fetch());
            }

            self::assertSame(
                [],
                $inherited,
                'every public PDO, Pdo\\Pgsql and PDOStatement method is implemented by the connected adapter'
            );
            self::assertSame([], $nonInternal, 'every extension-mode adapter method is native');
            $statement->closeCursor();
        });
    }

    protected function assertPgsqlAdapterExecutesBoundValuesAndRollsBack(bool $native): void
    {
        self::onPostgresDb(static function (\Polyspec\Orm\Db $db) use ($native): void {
            $pdo = $db->pdo();
            self::assertInstanceOf(PDO::class, $pdo);
            self::assertSame('pgsql', $pdo->getAttribute(PDO::ATTR_DRIVER_NAME));

            $pdoMethods = [
                'getAttribute', 'prepare', 'exec', 'query', 'beginTransaction', 'inTransaction', 'rollBack',
            ];
            foreach ($pdoMethods as $method) {
                $reflection = new ReflectionMethod($pdo, $method);
                self::assertSame(
                    $pdo::class,
                    $reflection->getDeclaringClass()->getName(),
                    "$method is handled by the adapter, not an uninitialized PDO parent method"
                );
                if ($native) {
                    self::assertTrue($reflection->isInternal(), "$method is implemented by the native adapter");
                }
            }

            $statement = $pdo->prepare('SELECT ?::integer AS value, ?::text AS label');
            self::assertInstanceOf(\PDOStatement::class, $statement);
            foreach (['bindValue', 'execute', 'fetch', 'fetchColumn', 'closeCursor', 'rowCount'] as $method) {
                $reflection = new ReflectionMethod($statement, $method);
                self::assertSame(
                    $statement::class,
                    $reflection->getDeclaringClass()->getName(),
                    "$method is handled by adapter statement; the PDOStatement parent is uninitialized"
                );
                if ($native) {
                    self::assertTrue(
                        $reflection->isInternal(),
                        "$method is implemented by the native adapter statement"
                    );
                }
            }
            self::assertTrue($statement->bindValue(1, 41, PDO::PARAM_INT));
            self::assertTrue($statement->bindValue(2, 'prepared-value', PDO::PARAM_STR));
            self::assertTrue($statement->execute());
            self::assertSame(['value' => 41, 'label' => 'prepared-value'], $statement->fetch(PDO::FETCH_ASSOC));
            self::assertFalse($statement->fetch(PDO::FETCH_ASSOC));
            self::assertTrue($statement->closeCursor());

            $pdo->exec('CREATE TABLE adapter_transaction_probe (value INTEGER NOT NULL)');
            self::assertTrue($pdo->beginTransaction());
            self::assertTrue($pdo->inTransaction());
            $insert = $pdo->prepare('INSERT INTO adapter_transaction_probe (value) VALUES (?)');
            self::assertInstanceOf(\PDOStatement::class, $insert);
            self::assertTrue($insert->bindValue(1, 7, PDO::PARAM_INT));
            self::assertTrue($insert->execute());
            self::assertSame(1, $insert->rowCount());
            self::assertTrue($pdo->rollBack());
            self::assertFalse($pdo->inTransaction());
            self::assertSame(
                0,
                (int) $pdo->query('SELECT count(*) FROM adapter_transaction_probe')->fetchColumn()
            );
        });
    }

    protected function assertPgsqlAdapterFetchModesAndMetadata(bool $native): void
    {
        self::onPostgresDb(static function (\Polyspec\Orm\Db $db) use ($native): void {
            $pdo = $db->pdo();
            $pdoMethods = [
                'lastInsertId', 'quote', 'errorCode', 'errorInfo', 'setAttribute', 'getPid',
                'escapeIdentifier', 'getNotify',
            ];
            self::assertAdapterDeclares($pdo, $pdoMethods, $native);
            $statement = $pdo->query('SELECT 7::integer AS value, true AS active, NULL::text AS missing');
            self::assertInstanceOf(\PDOStatement::class, $statement);
            $metadata = $statement->getColumnMeta(0);
            self::assertIsArray($metadata);
            self::assertSame('value', $metadata['name']);
            self::assertSame('int4', $metadata['native_type']);
            self::assertSame(23, $metadata['pgsql:oid']);
            self::assertSame(3, $statement->columnCount());
            self::assertSame(
                ['value' => 7, 'active' => true, 'missing' => null],
                $statement->fetch(PDO::FETCH_ASSOC)
            );
            self::assertFalse($statement->fetch(PDO::FETCH_ASSOC));

            $boundValue = null;
            $boundStatement = $pdo->prepare('SELECT 12::integer AS bound_value');
            self::assertInstanceOf(\PDOStatement::class, $boundStatement);
            self::assertTrue($boundStatement->bindColumn('bound_value', $boundValue, PDO::PARAM_INT));
            self::assertTrue($boundStatement->execute());
            self::assertTrue($boundStatement->fetch(PDO::FETCH_BOUND));
            self::assertSame(12, $boundValue);

            $byNumber = $pdo->query("SELECT 8::integer AS value, 'number'::text AS label", PDO::FETCH_NUM);
            self::assertInstanceOf(\PDOStatement::class, $byNumber);
            self::assertSame([8, 'number'], $byNumber->fetch());

            $asObject = $pdo->query("SELECT 9::integer AS value, 'object'::text AS label");
            self::assertInstanceOf(\PDOStatement::class, $asObject);
            $object = $asObject->fetchObject();
            self::assertInstanceOf(\stdClass::class, $object);
            self::assertSame(9, $object->value);
            self::assertSame('object', $object->label);

            self::assertTrue($pdo->setAttribute(PDO::ATTR_STRINGIFY_FETCHES, true));
            self::assertSame('10', $pdo->query('SELECT 10::integer')->fetchColumn());
            self::assertTrue($pdo->setAttribute(PDO::ATTR_STRINGIFY_FETCHES, false));
            self::assertSame(11, $pdo->query('SELECT 11::integer')->fetchColumn());

            $quoted = $pdo->quote("adapter's value");
            self::assertIsString($quoted);
            self::assertSame("adapter's value", $pdo->query("SELECT $quoted::text")->fetchColumn());

            try {
                $pdo->query('SELECT * FROM pdo_adapter_missing_relation');
                self::fail('a missing relation must throw in exception mode');
            } catch (\PDOException) {
                self::assertSame('42P01', $pdo->errorCode());
                self::assertSame('42P01', $pdo->errorInfo()[0]);
            }
        });
    }

    protected function assertPgsqlAdapterLastInsertIdTracksSequence(): void
    {
        self::onPostgresDb(static function (\Polyspec\Orm\Db $db): void {
            $pdo = $db->pdo();
            $pdo->exec('CREATE TABLE pdo_adapter_identity (id BIGSERIAL PRIMARY KEY, label TEXT NOT NULL)');
            $insert = $pdo->prepare('INSERT INTO pdo_adapter_identity (label) VALUES (?)');
            self::assertInstanceOf(\PDOStatement::class, $insert);
            self::assertTrue($insert->bindValue(1, 'sequence-value', PDO::PARAM_STR));
            self::assertTrue($insert->execute());
            self::assertSame('1', $pdo->lastInsertId());
            self::assertSame('1', $pdo->lastInsertId('pdo_adapter_identity_id_seq'));
            self::assertSame(
                ['id' => 1, 'label' => 'sequence-value'],
                $pdo->query('SELECT id, label FROM pdo_adapter_identity')->fetch(PDO::FETCH_ASSOC)
            );
        });
    }

    /**
     * A failed statement of the adapter throws a PDOException that carries its SQLSTATE in errorInfo, as a PDO driver
     * error does, so the error catalog reads DUPLICATE_KEY from it.
     */
    protected function assertPgsqlAdapterStatementErrorCarriesItsSqlState(): void
    {
        self::onPostgresDb(static function (\Polyspec\Orm\Db $db): void {
            $pdo = $db->pdo();
            $pdo->exec('CREATE TABLE pdo_adapter_unique (label TEXT PRIMARY KEY)');
            $pdo->exec("INSERT INTO pdo_adapter_unique (label) VALUES ('a')");
            try {
                $pdo->exec("INSERT INTO pdo_adapter_unique (label) VALUES ('a')");
                self::fail('a duplicate key was inserted');
            } catch (\PDOException $error) {
                self::assertSame('23505', $error->errorInfo[0] ?? null, 'the PDOException carries the SQLSTATE');
                self::assertSame($error->getMessage(), $error->errorInfo[2] ?? null);
                self::assertSame($error->errorInfo, $pdo->errorInfo());
                self::assertSame(\Polyspec\Orm\Code::DUPLICATE_KEY, $db->driverError($error)->code_);
            }
        });
    }

    protected function assertPgsqlAdapterBoundParametersPreserveReferencesAndTypes(bool $native): void
    {
        self::onPostgresDb(static function (\Polyspec\Orm\Db $db, string $dsn) use ($native): void {
            $pdo = $db->pdo();
            $statement = $pdo->prepare(
                'SELECT ?::integer AS value, ?::boolean AS active, ?::text AS label'
            );
            self::assertInstanceOf(\PDOStatement::class, $statement);
            foreach (['bindParam', 'bindValue', 'execute'] as $method) {
                $reflection = new ReflectionMethod($statement, $method);
                self::assertSame(
                    $statement::class,
                    $reflection->getDeclaringClass()->getName(),
                    "$method is handled by the PostgreSQL statement adapter"
                );
                if ($native) {
                    self::assertTrue(
                        $reflection->isInternal(),
                        "$method is implemented by the native adapter statement"
                    );
                }
            }

            $value = 41;
            $active = true;
            $label = 'first';
            self::assertTrue($statement->bindParam(1, $value, PDO::PARAM_INT));
            self::assertTrue($statement->bindParam(2, $active, PDO::PARAM_BOOL));
            self::assertTrue($statement->bindParam(3, $label, PDO::PARAM_STR));
            self::assertTrue($statement->execute());
            self::assertSame([41, true, 'first'], $statement->fetch(PDO::FETCH_NUM));

            $value = 42;
            $active = false;
            $label = 'second';
            self::assertTrue($statement->execute());
            self::assertSame([42, false, 'second'], $statement->fetch(PDO::FETCH_NUM));

            $arrayParameters = $pdo->prepare('SELECT ?::integer AS value');
            self::assertInstanceOf(\PDOStatement::class, $arrayParameters);
            self::assertTrue($arrayParameters->execute([17]));
            self::assertSame(17, $arrayParameters->fetchColumn());

            $namedParameters = $pdo->prepare('SELECT :value::integer AS value, :label::text AS label');
            self::assertInstanceOf(\PDOStatement::class, $namedParameters);
            self::assertTrue($namedParameters->bindValue(':value', 18, PDO::PARAM_INT));
            self::assertTrue($namedParameters->bindValue('label', 'named-value', PDO::PARAM_STR));
            self::assertTrue($namedParameters->execute());
            self::assertSame([18, 'named-value'], $namedParameters->fetch(PDO::FETCH_NUM));

            [$driver, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
            self::assertSame('postgres', $driver);
            $reference = \Pdo\Pgsql::connect(
                $pdoDsn,
                $user,
                $password,
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
            );
            try {
                $binary = "\x00\xff\x41";
                $typedSelect = "SELECT 42::integer AS integer_value, true AS boolean_value, "
                    . "false AS false_boolean_value, "
                    . "NULL::text AS null_value, 1.5::double precision AS float_value, "
                    . "decode('00ff41', 'hex') AS payload";
                foreach ([false, true] as $stringifyFetches) {
                    self::assertTrue($pdo->setAttribute(PDO::ATTR_STRINGIFY_FETCHES, $stringifyFetches));
                    self::assertTrue($reference->setAttribute(PDO::ATTR_STRINGIFY_FETCHES, $stringifyFetches));
                    $expected = $reference->query($typedSelect)->fetch(PDO::FETCH_ASSOC);
                    $actual = $pdo->query($typedSelect)->fetch(PDO::FETCH_ASSOC);
                    self::assertIsArray($expected);
                    self::assertIsArray($actual);
                    $expectedPayload = $expected['payload'];
                    $actualPayload = $actual['payload'];
                    if ($stringifyFetches) {
                        self::assertIsString($expectedPayload);
                        self::assertIsString($actualPayload);
                    } else {
                        self::assertIsResource($expectedPayload);
                        self::assertIsResource($actualPayload);
                    }
                    $expectedBytes = is_resource($expectedPayload)
                        ? stream_get_contents($expectedPayload)
                        : $expectedPayload;
                    $actualBytes = is_resource($actualPayload)
                        ? stream_get_contents($actualPayload)
                        : $actualPayload;
                    self::assertSame($binary, $expectedBytes);
                    self::assertSame($expectedBytes, $actualBytes);
                    if (is_resource($expectedPayload)) {
                        self::assertTrue(fclose($expectedPayload));
                    }
                    if (is_resource($actualPayload)) {
                        self::assertTrue(fclose($actualPayload));
                    }
                    unset($expected['payload'], $actual['payload']);
                    self::assertSame($expected, $actual);

                    $expectedBound = $reference->prepare('SELECT ?::bytea AS payload');
                    $actualBound = $pdo->prepare('SELECT ?::bytea AS payload');
                    self::assertInstanceOf(\PDOStatement::class, $expectedBound);
                    self::assertInstanceOf(\PDOStatement::class, $actualBound);
                    self::assertTrue($expectedBound->bindValue(1, $binary, PDO::PARAM_LOB));
                    self::assertTrue($actualBound->bindValue(1, $binary, PDO::PARAM_LOB));
                    self::assertTrue($expectedBound->execute());
                    self::assertTrue($actualBound->execute());
                    $expectedBoundPayload = $expectedBound->fetch(PDO::FETCH_ASSOC)['payload'];
                    $actualBoundPayload = $actualBound->fetch(PDO::FETCH_ASSOC)['payload'];
                    if ($stringifyFetches) {
                        self::assertIsString($expectedBoundPayload);
                        self::assertIsString($actualBoundPayload);
                    } else {
                        self::assertIsResource($expectedBoundPayload);
                        self::assertIsResource($actualBoundPayload);
                    }
                    $expectedBoundBytes = is_resource($expectedBoundPayload)
                        ? stream_get_contents($expectedBoundPayload)
                        : $expectedBoundPayload;
                    $actualBoundBytes = is_resource($actualBoundPayload)
                        ? stream_get_contents($actualBoundPayload)
                        : $actualBoundPayload;
                    self::assertSame($binary, $expectedBoundBytes);
                    self::assertSame($expectedBoundBytes, $actualBoundBytes);
                    if (is_resource($expectedBoundPayload)) {
                        self::assertTrue(fclose($expectedBoundPayload));
                    }
                    if (is_resource($actualBoundPayload)) {
                        self::assertTrue(fclose($actualBoundPayload));
                    }
                }

                $debugSql = 'SELECT ?::integer AS debug_value';
                $referenceDebugStatement = $reference->prepare($debugSql);
                $adapterDebugStatement = $pdo->prepare($debugSql);
                self::assertInstanceOf(\PDOStatement::class, $referenceDebugStatement);
                self::assertInstanceOf(\PDOStatement::class, $adapterDebugStatement);
                self::assertTrue($referenceDebugStatement->bindValue(1, 42, PDO::PARAM_INT));
                self::assertTrue($adapterDebugStatement->bindValue(1, 42, PDO::PARAM_INT));
                ob_start();
                $referenceDebugReturn = $referenceDebugStatement->debugDumpParams();
                $referenceDebugOutput = ob_get_clean();
                ob_start();
                $adapterDebugReturn = $adapterDebugStatement->debugDumpParams();
                $adapterDebugOutput = ob_get_clean();
                self::assertNull($referenceDebugReturn);
                self::assertNull($adapterDebugReturn);
                self::assertStringContainsString('Params:', $referenceDebugOutput);
                self::assertStringContainsString('paramno=0', $referenceDebugOutput);
                self::assertSame($referenceDebugOutput, $adapterDebugOutput);

                $referenceArrayDebug = $reference->prepare($debugSql);
                $adapterArrayDebug = $pdo->prepare($debugSql);
                self::assertInstanceOf(\PDOStatement::class, $referenceArrayDebug);
                self::assertInstanceOf(\PDOStatement::class, $adapterArrayDebug);
                self::assertTrue($referenceArrayDebug->execute([42]));
                self::assertTrue($adapterArrayDebug->execute([42]));
                ob_start();
                $referenceArrayReturn = $referenceArrayDebug->debugDumpParams();
                $referenceArrayOutput = ob_get_clean();
                ob_start();
                $adapterArrayReturn = $adapterArrayDebug->debugDumpParams();
                $adapterArrayOutput = ob_get_clean();
                self::assertNull($referenceArrayReturn);
                self::assertNull($adapterArrayReturn);
                self::assertStringContainsString('Params:', $referenceArrayOutput);
                self::assertStringContainsString('paramno=0', $referenceArrayOutput);
                self::assertSame($referenceArrayOutput, $adapterArrayOutput);
            } finally {
                $reference = null;
            }
        });
    }

    protected function assertPgsqlAdapterPostgresConnectionMethods(bool $native): void
    {
        self::onPostgresDb(static function (\Polyspec\Orm\Db $db) use ($native): void {
            $pdo = $db->pdo();
            self::assertAdapterDeclares($pdo, ['getPid', 'escapeIdentifier', 'getNotify'], $native);

            $backendPid = $pdo->getPid();
            self::assertGreaterThan(0, $backendPid);
            self::assertSame('PostgreSQL connection OK', $pdo->getAttribute(PDO::ATTR_CONNECTION_STATUS));

            $identifier = 'adapter " escaped';
            $quotedIdentifier = $pdo->escapeIdentifier($identifier);
            self::assertSame('"adapter "" escaped"', $quotedIdentifier);
            self::assertSame(
                [$identifier => 1],
                $pdo->query("SELECT 1 AS $quotedIdentifier")->fetch(PDO::FETCH_ASSOC)
            );

            $channel = 'pgsql_adapter_' . getmypid() . '_' . bin2hex(random_bytes(4));
            $payload = 'notification-payload';
            $pdo->exec('LISTEN "' . $channel . '"');
            $notify = $pdo->prepare('SELECT pg_notify(?, ?)');
            self::assertInstanceOf(\PDOStatement::class, $notify);
            self::assertTrue($notify->execute([$channel, $payload]));
            $notification = $pdo->getNotify(PDO::FETCH_ASSOC);
            self::assertIsArray($notification);
            self::assertSame($channel, $notification['message']);
            self::assertSame($payload, $notification['payload']);
            self::assertSame($backendPid, $notification['pid']);
        });
    }

    protected function assertPgsqlAdapterCopyAndLargeObjectMethods(bool $native): void
    {
        self::onPostgresDb(static function (\Polyspec\Orm\Db $db) use ($native): void {
            $pdo = $db->pdo();
            $methods = [
                'copyFromArray', 'copyFromFile', 'copyToArray', 'copyToFile', 'lobCreate', 'lobOpen', 'lobUnlink',
            ];
            self::assertAdapterDeclares($pdo, $methods, $native);
            $copyPath = tempnam(sys_get_temp_dir(), 'orm-pg-copy-');
            if ($copyPath === false) {
                self::fail('could not create a temporary PostgreSQL COPY file');
            }
            $largeObject = null;
            $largeObjectStream = null;
            try {
                $pdo->exec('CREATE TEMP TABLE pdo_adapter_copy (id INTEGER NOT NULL, label TEXT NOT NULL)');
                self::assertTrue($pdo->copyFromArray(
                    'pdo_adapter_copy',
                    ['1' . "\t" . 'alpha', '2' . "\t" . 'beta'],
                    "\t",
                    '\\N',
                    'id,label'
                ));
                self::assertSame(
                    ['1' . "\t" . 'alpha', '2' . "\t" . 'beta'],
                    $pdo->copyToArray('pdo_adapter_copy', "\t", '\\N', 'id,label')
                );
                self::assertTrue($pdo->copyToFile('pdo_adapter_copy', $copyPath, "\t", '\\N', 'id,label'));
                self::assertSame(
                    "1\talpha\n2\tbeta\n",
                    file_get_contents($copyPath)
                );
                $pdo->exec('CREATE TEMP TABLE pdo_adapter_copy_file (id INTEGER NOT NULL, label TEXT NOT NULL)');
                self::assertTrue($pdo->copyFromFile('pdo_adapter_copy_file', $copyPath, "\t", '\\N', 'id,label'));
                self::assertSame(
                    [[1, 'alpha'], [2, 'beta']],
                    $pdo->query('SELECT id, label FROM pdo_adapter_copy_file ORDER BY id')->fetchAll(PDO::FETCH_NUM)
                );

                self::assertTrue($pdo->beginTransaction());
                $largeObject = $pdo->lobCreate();
                self::assertIsString($largeObject);
                $largeObjectStream = $pdo->lobOpen($largeObject, 'w+');
                self::assertIsResource($largeObjectStream);
                $payload = "\0postgres-large-object\xff";
                self::assertSame(strlen($payload), fwrite($largeObjectStream, $payload));
                self::assertTrue(rewind($largeObjectStream));
                self::assertSame($payload, fread($largeObjectStream, strlen($payload)));
                self::assertTrue(fclose($largeObjectStream));
                $largeObjectStream = null;
                self::assertTrue($pdo->lobUnlink($largeObject));
                self::assertTrue($pdo->commit());
                $largeObject = null;
            } finally {
                if (is_resource($largeObjectStream) && !fclose($largeObjectStream)) {
                    throw new \RuntimeException('failed to close the PostgreSQL large-object stream');
                }
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                if (file_exists($copyPath) && !unlink($copyPath)) {
                    throw new \RuntimeException("failed to remove PostgreSQL COPY fixture $copyPath");
                }
            }
        });
    }
}
