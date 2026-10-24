import assert from 'node:assert/strict';
import { caseTest } from '../../../tests/testcase.mts';
import { mysqlTestOptions } from './mysql-test-options.mjs';

caseTest('decodes MySQL DSN credentials and keeps socket and database options', 1000, () => {
  assert.deepEqual(mysqlTestOptions('mysql://user%40test:p%2Fss@db.example:3307/?socket=%2Ftmp%2Fmysql.sock', 'orm_test'), {
    user: 'user@test',
    password: 'p/ss',
    socketPath: '/tmp/mysql.sock',
    host: 'db.example',
    port: 3307,
    database: 'orm_test',
  });
});

caseTest('leaves absent MySQL socket and port options undefined', 1000, () => {
  assert.deepEqual(mysqlTestOptions('mysql://user:secret@localhost', undefined), {
    user: 'user',
    password: 'secret',
    socketPath: undefined,
    host: 'localhost',
    port: undefined,
    database: undefined,
  });
});
