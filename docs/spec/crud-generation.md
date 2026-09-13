# CRUD generation directives

This specification defines the `orm:*` metadata preserved from Mermaid schema sources. The directives describe public CRUD input and are not SQL. The core ORM preserves them; a profile validator decides whether a public CRUD surface can be generated.

Every directive occupies one physical line. Continuation lines, unknown options, duplicate options, and duplicate declarations are errors. The parser does not infer roles from FK names or relationship labels.

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

`fk` is the physical foreign key target. `public` is the stable resolver key of that target. `scope` values are resolved and added to list, detail, update, and delete ORM builders; insert uses them as FK values. `reference` values are used only by an explicit body or route filter. `owner` is a permission candidate and requires a separate permission declaration. `resource-key` identifies one public resource; `seq` and internal FK values are never public keys.

The generated source calls the ORM builder and terminal methods. It does not contain SQL, driver calls, or database procedures. Write resolvers and mutations run in one ORM transaction. A caller-owned transaction is accepted through the generated transaction binding and is not committed by the wrapper.
