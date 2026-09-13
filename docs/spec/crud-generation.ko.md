# CRUD 생성 directive

이 명세는 Mermaid schema source에서 보존하는 `orm:*` metadata를 정의한다. directive는 공개 CRUD 입력을 설명하며 SQL이 아니다. core ORM은 directive를 보존하고, profile validator가 공개 CRUD 생성 가능 여부를 결정한다.

모든 directive는 하나의 물리적 줄을 사용한다. continuation 줄, 알 수 없는 option, 중복 option, 중복 선언은 오류다. parser는 FK 이름이나 관계선 label로 역할을 추론하지 않는다.

```text
%% orm:field product.company_seq relation=scope fk=company.seq public=company.uuid required=true order=1
%% orm:field product.store_seq relation=scope fk=store.seq public=store.uuid required=true order=2
%% orm:field product.user_seq relation=reference fk=user.seq public=user.uuid required=false
%% orm:public-key entity=product field=uuid type=uuid unique=true stable=true
%% orm:route product.item
%% orm:path /company/{company_uuid}/store/{store_uuid}/product/{product_uuid}
%% orm:scope route=product.item param=company_uuid field=product.company_seq
%% orm:scope route=product.item param=store_uuid field=product.store_seq
%% orm:resource-key route=product.item param=product_uuid field=product.uuid
%% orm:operation route=product.item method=GET
%% orm:operation route=product.item method=PATCH
%% orm:operation route=product.item method=DELETE
```

`fk`는 물리 FK 대상이고 `public`은 대상의 안정적인 resolver key다. `scope` 값은 resolver로 해석해 목록·상세·수정·삭제 ORM builder에 추가하며 insert에서는 FK 값으로 사용한다. `reference` 값은 명시된 body 또는 route filter에서만 사용한다. `owner`는 권한 후보이며 별도 permission 선언이 필요하다. `resource-key`는 하나의 공개 자원을 식별하며 `seq`와 내부 FK 값은 public key가 될 수 없다.

생성 source는 ORM builder와 terminal method를 호출한다. SQL, 직접 driver 호출, database procedure를 포함하지 않는다. write resolver와 mutation은 하나의 ORM transaction에서 실행한다. caller-owned transaction은 생성 binding으로 받고 wrapper가 commit하지 않는다.
