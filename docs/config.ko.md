# 런타임 연결

연결값은 ORM에 인자로 전달되며, 환경 변수나 secret 저장소에서 온다. 런타임 연결은 설정 파일을 읽지 않는다.

DSN scheme만 database 종류를 결정한다.

```text
mysql://user:password@host:3306/orm_example?parseTime=true&clientFoundRows=true
postgres://user:password@host:5432/orm_example?sslmode=disable
sqlite:///var/lib/orm_example.sqlite
```

client는 scheme을 파싱하고 해당 native driver와 connection pool을 생성한다. Query compiler 초기화와 schema 검증은 runtime 내부에서 처리한다. engine은 생성하거나 전달하지 않는다.

Database 자격 증명과 AES key는 commit하거나 runtime 파일에 저장하거나 log에 기록하지 않는다. 배포 secret source에서 값을 읽은 뒤 connection options로 전달한다.
