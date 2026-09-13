# Runtime connection

The application supplies connection values from environment injection or a Secret Manager. The runtime connection does not read a configuration file.

The DSN scheme is the only database selector:

```text
mysql://user:password@host:3306/app?parseTime=true&clientFoundRows=true
postgres://user:password@host:5432/app?sslmode=disable
sqlite:///var/lib/app.sqlite
```

The client parses the scheme, creates the matching native driver and opens its pool. Query compiler setup and schema validation are internal runtime operations. Applications do not create or pass an engine.

Database credentials and AES keys must not be committed, written to runtime files, or included in logs. Pass them through the application connection options after resolving them from the deployment secret source.
