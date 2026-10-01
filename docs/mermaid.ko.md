# Mermaid diagram

dbspec 문서가 schema의 원천이고, Mermaid `erDiagram`은 다른 도구를 위한 view다. export는 dbspec 문서에서 표준 `erDiagram`을 쓰고, import는 표준 `erDiagram`을 dbspec 문서로 읽으며 옮기지 못한 것을 모두 나열한다. `tests/dbspec/mermaid.json`이 공유 case를 담는다.

## Export

export는 문서 하나에 diagram 하나를 쓴다. table은 이름 순, column은 문서 순이다.

```
erDiagram
    orders {
        i64 id PK "identity"
        i64 user_id FK
        decimal(10-2) total "default 0.00"
    }
    users {
        i64 id PK "identity"
        varchar(64) mail UK
        i32 age "null"
    }
    users ||--o{ orders : "fk_orders_user (user_id) references (id)"
```

- 첫 줄은 `erDiagram`이고, 다른 줄은 단계마다 공백 네 칸으로 들여 쓰며, text는 줄 끝으로 끝난다.
- column은 `<type> <name>` 뒤에 key와, 있으면 comment를 쓴다. type은 dbspec type이며, Mermaid type에는 쉼표가 없으므로 `decimal(p,s)`를 `decimal(p-s)`로 쓴다. key는 primary key column이면 `PK`, foreign key column이면 `FK`, unique key column이면 `UK`이고, 이 순서로 `, `로 구분한다. comment는 dbspec column 줄의 뒷부분, 곧 dbspec이 쓰는 대로의 `null`, `identity`, `default <literal>`을 담으며, 뒷부분이 비면 쓰지 않는다. `"`를 담은 default는 Mermaid comment에 쓸 수 없으므로 export는 그 default 없이 column을 쓰고 default를 보고한다.
- foreign key는 참조되는 table에서 table로 가는 relationship이며, table 순, 그다음 foreign key 이름 순이다. key의 모든 column이 non-null이면 `<parent> ||--o{ <child>`, 아니면 `<parent> |o--o{ <child>`이고, label은 `"<name> (<columns>) references (<referenced columns>)"`다.
- export는 comment, unique key(column만 표시한다), index, check, `restrict`가 아닌 foreign key action, settings, diagram, `use` 줄을 빼고 각각 보고한다. export는 text와, 뺀 것을 table, kind, 이름 순의 `[kind, table, name]` 목록으로 돌려준다.

## Import

import는 표준 `erDiagram`을 호출자가 이름을 준 문서로 읽는다. entity, attribute, relationship의 Mermaid 문법을 받는다: 문자, 숫자, `_`, `-`로 된 entity 이름이나 큰따옴표 안의 이름, `<type> <name> [keys] ["comment"]` attribute, 왼쪽에 `|o`, `||`, `}o`, `}|`, 오른쪽에 `o|`, `||`, `o{`, `|{`, 그 사이에 `--`나 `..`, 그리고 단어나 따옴표 label을 가진 relationship이다. `%%` comment 줄과 빈 줄은 건너뛰고, 그 밖의 줄과 문법을 따르지 않는 줄은 그 줄의 `mermaid` diagnostic이다.

import가 옮기는 것과 `[kind, entity, name, reason]`으로 보고하는 것은 다음과 같다.

- **Table.** entity는 이름이 dbspec 이름이고 primary key가 있으면 table이 된다. 아니면 `table`로 보고하고 그 relationship과 함께 뺀다.
- **Column.** attribute는 이름이 dbspec 이름이고 type이 dbspec type(`decimal(p-s)` 포함)이면 column이 된다. 아니면 `column`으로 보고하고 뺀다. `[null] [identity] [default <literal>]` 형식의 comment는 그 부분들을 주고, 다른 comment는 `comment`로 보고하며 column은 default 없는 non-null이 된다.
- **Key.** attribute 순서의 `PK` attribute가 primary key다. `UK` attribute는 Mermaid가 어느 것이 한 key를 이루는지 말하지 않으므로 `unique`로 보고한다.
- **Foreign key.** label이 `"<name> (<columns>) references (<referenced columns>)"`이고, column이 many 쪽의 `FK` attribute이며, 참조 column이 one 쪽에 있는 relationship은 action이 `restrict`인 foreign key `<name>`이 된다. 다른 relationship은 두 entity와 label과 함께 `relationship`으로 보고한다. 어떤 relationship도 쓰지 않는 `FK` attribute는 `foreign_key`로 보고한다. table의 primary key가 foreign key의 column으로 시작하지 않으면, import는 dbspec이 요구하는 index `ix_<table>_<_로 이은 columns>`를 더하고, Mermaid에는 index가 없으므로 `index`로 보고한다.
- **Cardinality.** dbspec은 cardinality를 foreign key에서 얻는다. cardinality가 export가 그 nullability에 쓰는 것과 다른 relationship은 `cardinality`로 보고한다.

import한 문서는 parse되며, introspection처럼 parse가 거부한 줄의 객체는 그 dbspec diagnostic과 함께 보고되고 빠진다. 문서가 parse될 때까지 반복한다. export를 import하면 export가 보고한 것을 뺀 원래 문서에 보고한 index를 더한 문서가 나온다.
