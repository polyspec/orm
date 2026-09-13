# Runtime connection

Connection values reach the ORM as arguments, read from an environment variable or a secret store. The runtime connection does not read a configuration file.

The DSN scheme is the only database selector:

```text
mysql://user:password@host:3306/orm_example?parseTime=true&clientFoundRows=true
postgres://user:password@host:5432/orm_example?sslmode=disable
sqlite:///var/lib/orm_example.sqlite
```

The client parses the scheme, creates the matching native driver and opens its pool. Query compiler setup and schema validation are internal runtime operations. No engine is created or passed.

Database credentials and AES keys must not be committed, written to runtime files, or included in logs. Pass them through the connection options after resolving them from the deployment secret source.
