# 런타임 연결

애플리케이션은 환경 주입 또는 Secret Manager에서 연결값을 받아 ORM에 전달한다. 런타임 연결은 설정 파일을 읽지 않는다.

DSN scheme만 database 종류를 결정한다.

```text
mysql://user:password@host:3306/app?parseTime=true&clientFoundRows=true
postgres://user:password@host:5432/app?sslmode=disable
sqlite:///var/lib/app.sqlite
```

client는 scheme을 파싱하고 해당 native driver와 connection pool을 생성한다. Query compiler 초기화와 schema 검증은 runtime 내부에서 처리한다. 애플리케이션은 engine을 생성하거나 전달하지 않는다.

Database 자격 증명과 AES key는 commit하거나 runtime 파일에 저장하거나 log에 기록하지 않는다. 배포 secret source에서 값을 읽은 뒤 connection options로 전달한다.
