# 복잡한 쿼리 예 — 상품 검색 목록 (dsl.md v3 문법)

여러 관계와 조건 패턴을 하나로 합친 시나리오:
- 루트 `product` — 서비스·노출 조건 + **노출 스케줄 OR 그룹** + **키워드 OR 검색(루트 + 조인 테이블 2개)**
- 카테고리 필터 **INNER JOIN** + `groupBySeq` (M:N 필터 관용구)
- 관계: `lang`(1:1, `flatten`으로 평탄화), `brand`(1:1) → 그 안의 `lang`(평탄화), `reviews`(1:N, **부모당 3개**, 각 리뷰의 `user` 1:1), `myOrderItem`(1:1, 로그인 사용자 것만, **부모당 1개**)
- 정렬 2키, 페이지네이션

YAML `relations:` (product):
```yaml
relations:
  lang:        {kind: one,  target: product_lang,       right: product_seq}
  brand:       {kind: one,  target: product_brand,      left: product_brand_seq, right: seq}
  reviews:     {kind: many, target: product_review,     right: product_seq}
  my_order_item: {kind: one, target: order_product_item, right: product_seq}
  categories:  {kind: many, target: product_match_category, right: product_seq}   # 조인에도 사용
  brand_lang_all: {kind: many, target: product_brand_lang, left: product_brand_seq, right: product_brand_seq}  # 키워드 검색 조인용(동명 FK)
  lang_all:       {kind: many, target: product_lang, right: product_seq}                                  # 키워드 검색 조인용(언어 무관)
```

## PHP
```php
$page = Product::query()
    ->relationLang(ProductLang::query()->langId($langId)->flatten())
    ->relationBrand(ProductBrand::query()
        ->relationLang(ProductBrandLang::query()->langId($langId)->flatten()))
    ->relationsReviews(ProductReview::query()
        ->isClose(0)->orderBySeqDesc()->limitPerParent(3)->keyBySeq()
        ->relation(User::query()->selectNone()->selectName()->selectProfileUrl()))
    ->relationMyOrderItem(OrderProductItem::query()
        ->serviceMemberSeq($memberSeq)->isClose(0)->orderBySeqDesc()->limitPerParent(1))
    ->joinCategories(ProductMatchCategory::query()
        ->selectNone()
        ->where(fn($c) => $c->serviceModuleCategoryItemSeqIn($categorySeqs)))
    ->leftJoinBrandLangAll(ProductBrandLang::query()->selectNone())
    ->leftJoinLangAll(ProductLang::query()->selectNone())
    ->serviceSeq($serviceSeq)->isClose(0)->isDisplay(1)
    ->and(fn($w) => $w
        ->isAllday(1)
        ->or(fn($w) => $w->isAllday(0)->displayStartDtLte($now)->displayEndDtGte($now)))
    ->and(fn($w) => $w
        ->nameWithShortDescriptionWithContentMatchBoolean($kw)
        ->or()->brandLangAll(fn($b) => $b->nameWithDescriptionMatchBoolean($kw))
        ->or()->langAll(fn($l) => $l->nameWithShortDescriptionWithContentMatchBoolean($kw)))
    ->groupBySeq()
    ->orderByLikeCountDesc()->orderBySeqDesc()
    ->using($db)->paginate($pageNo, 20);

foreach ($page->items as $seq => $p) {
    $p->getName();                         // lang이 flatten으로 평탄화됨 → 루트 컬럼처럼
    $p->getBrand()?->getName();            // brand → brand.lang 평탄화
    foreach ($p->getReviews() as $reviewSeq => $r) { $r->getUser()->getName(); }
    $p->getMyOrderItem()?->getSeq();       // 없으면 null
}
$page->total; $page->pages;
```

## Go
```go
page, err := m.Product().
    RelationLang(m.ProductLang().LangId(langId).Flatten()).
    RelationBrand(m.ProductBrand().
        RelationLang(m.ProductBrandLang().LangId(langId).Flatten())).
    RelationsReviews(m.ProductReview().
        IsClose(0).OrderBySeqDesc().LimitPerParent(3).KeyBySeq().
        Relation(m.User().SelectNone().SelectName().SelectProfileUrl())).
    RelationMyOrderItem(m.OrderProductItem().
        ServiceMemberSeq(memberSeq).IsClose(0).OrderBySeqDesc().LimitPerParent(1)).
    JoinCategories(m.ProductMatchCategory().
        SelectNone().
        Where(func(c *m.ProductMatchCategoryWhere) { c.ServiceModuleCategoryItemSeqIn(categorySeqs) })).
    LeftJoinBrandLangAll(m.ProductBrandLang().SelectNone()).
    LeftJoinLangAll(m.ProductLang().SelectNone()).
    ServiceSeq(serviceSeq).IsClose(0).IsDisplay(1).
    And(func(w *m.ProductWhere) {
        w.IsAllday(1)
        w.Or(func(w *m.ProductWhere) { w.IsAllday(0).DisplayStartDtLte(now).DisplayEndDtGte(now) })
    }).
    And(func(w *m.ProductWhere) {
        w.NameWithShortDescriptionWithContentMatchBoolean(kw)
        w.Or().BrandLangAll(func(b *m.ProductBrandLangWhere) { b.NameWithDescriptionMatchBoolean(kw) })
        w.Or().LangAll(func(l *m.ProductLangWhere) { l.NameWithShortDescriptionWithContentMatchBoolean(kw) })
    }).
    GroupBySeq().
    OrderByLikeCountDesc().OrderBySeqDesc().Using(db).Paginate(pageNo, 20)

for seq, p := range page.Items.All() {
    _ = p.Name                                  // lang 평탄화 → typed 필드
    _ = p.GetBrand().GetName()                  // nil-safe 체인
    for reviewSeq, r := range p.GetReviews().All() { _ = r.GetUser().GetName() }
    _ = p.GetMyOrderItem().GetSeq()             // nil이면 0
}
_ = page.Total; _ = page.Pages
```

## Rust
```rust
let page = product::query()
    .relation_lang(product_lang::query().lang_id(lang_id).flatten())
    .relation_brand(product_brand::query()
        .relation_lang(product_brand_lang::query().lang_id(lang_id).flatten()))
    .relations_reviews(product_review::query()
        .is_close(0).order_by_seq_desc().limit_per_parent(3).key_by_seq()
        .relation(user::query().select_none().select_name().select_profile_url()))
    .relation_my_order_item(order_product_item::query()
        .service_member_seq(member_seq).is_close(0).order_by_seq_desc().limit_per_parent(1))
    .join_categories(product_match_category::query()
        .select_none()
        .where_(|c| c.service_module_category_item_seq_in(category_seqs)))
    .left_join_brand_lang_all(product_brand_lang::query().select_none())
    .left_join_lang_all(product_lang::query().select_none())
    .service_seq(service_seq).is_close(0).is_display(1)
    .and(|w| w
        .is_allday(1)
        .or(|w| w.is_allday(0).display_start_dt_lte(now).display_end_dt_gte(now)))
    .and(|w| w
        .name_with_short_description_with_content_match_boolean(kw)
        .or().brand_lang_all(|b| b.name_with_description_match_boolean(kw))
        .or().lang_all(|l| l.name_with_short_description_with_content_match_boolean(kw)))
    .group_by_seq()
    .order_by_like_count_desc().order_by_seq_desc()
    .using(&db).paginate(page_no, 20).await?;

for (seq, p) in &page.items {
    let _ = &p.name;
    let _ = p.brand().map(|b| &b.name);
    for (review_seq, r) in p.reviews() { let _ = r.user().map(|u| &u.name); }
    let _ = p.my_order_item().map(|o| o.seq);
}
let _ = page.total; let _ = page.pages;
```

세 블록은 줄 단위로 대응한다. 다른 곳은 언어 고정 접사뿐: `X::query()`/`m.X()`/`x::query()`, 클로저 머리(`fn($w) =>` / `func(w *m.ProductWhere) {` / `|w|`), 터미널 `paginate($db,…)` / `Paginate(db,…)` / `paginate(&db,…).await?`, 결과 접근의 null 처리(`?->` / nil-safe getter / `Option`).

## 엔진이 만드는 Plan (MySQL dialect)

```
step 0  query   (루트 + 조인)  ← paginate가 count 변형도 같이 요청
  SELECT a.seq, a.name, …(product 기본 컬럼)      -- 조인 자식은 selectNone → PK/FK만
  FROM `product` AS `a`
  INNER JOIN `product_match_category` AS `b` ON `a`.`seq` = `b`.`product_seq`
  LEFT  JOIN `product_brand_lang` AS `brand_lang_all` ON `a`.`product_brand_seq` = `brand_lang_all`.`product_brand_seq`
  LEFT  JOIN `product_lang` AS `lang_all` ON `a`.`seq` = `lang_all`.`product_seq`
  WHERE `a`.`service_seq` = ? AND `a`.`is_close` = ? AND `a`.`is_display` = ?
    AND (`b`.`service_module_category_item_seq` IN (?, ?, ?))                     -- 조인 그룹(AND)
    AND (`a`.`is_allday` = ? OR (`a`.`is_allday` = ? AND `a`.`display_start_dt` <= ? AND `a`.`display_end_dt` >= ?))
    AND (MATCH(`a`.`name`, `a`.`short_description`, `a`.`content`) AGAINST (? IN BOOLEAN MODE)
         OR MATCH(`brand_lang_all`.`name`, `brand_lang_all`.`description`) AGAINST (? IN BOOLEAN MODE)
         OR MATCH(`lang_all`.`name`, `lang_all`.`short_description`, `lang_all`.`content`) AGAINST (? IN BOOLEAN MODE))
  GROUP BY `a`.`seq`
  ORDER BY `a`.`like_count` DESC, `a`.`seq` DESC
  LIMIT ?, ?
  binds: [service_seq, 0, 1, cat1, cat2, cat3, 1, 0, now, now, kw', kw', kw', offset, 20]
         (kw' = boolean full-text 규칙으로 "+w1 +w2*" 변환)

step 0c count  SELECT COUNT(DISTINCT `a`.`seq`) FROM … 같은 JOIN/WHERE (ORDER/LIMIT 제외)

step 1  query   lang (ONE, parent_node)        bind_from: step0.seq (dedup)
  SELECT `a`.`seq`, `a`.`product_seq`, `a`.`name`, … FROM `product_lang` AS `a`
  WHERE `a`.`product_seq` IN (?, …) AND `a`.`lang_id` = ?
  link: {kind: one, parent_column: seq, child_column: product_seq, parent_node: true}

step 2  query   brand (ONE)                    bind_from: step0.product_brand_seq
  SELECT … FROM `product_brand` AS `a` WHERE `a`.`seq` IN (?, …)
  link: {kind: one, parent_column: product_brand_seq, child_column: seq}

step 3  query   brand.lang (ONE, parent_node)  bind_from: step2.seq
  SELECT … FROM `product_brand_lang` AS `a` WHERE `a`.`product_brand_seq` IN (?, …) AND `a`.`lang_id` = ?
  link: {parent: step2, kind: one, parent_node: true}

step 4  query   reviews (MANY, group_limit 3)  bind_from: step0.seq
  SELECT * FROM (
    SELECT `a`.`seq`, `a`.`product_seq`, …,
           ROW_NUMBER() OVER (PARTITION BY `a`.`product_seq` ORDER BY `a`.`seq` DESC) AS `row_num`
    FROM `product_review` AS `a`
    WHERE `a`.`product_seq` IN (?, …) AND `a`.`is_close` = ?
  ) AS `ranked` WHERE `ranked`.`row_num` <= 3
  ORDER BY `ranked`.`seq` DESC
  link: {kind: many, parent_column: seq, child_column: product_seq, key_column: seq}   -- row_num은 조립 시 제거

step 5  query   reviews.user (ONE)             bind_from: step4.user_seq
  SELECT `a`.`seq`, `a`.`name`, `a`.`profile_url` FROM `user` AS `a` WHERE `a`.`seq` IN (?, …)
  link: {parent: step4, kind: one, parent_column: user_seq, child_column: seq}

step 6  query   my_order_item (ONE, group_limit 1)  bind_from: step0.seq
  SELECT * FROM ( SELECT …, ROW_NUMBER() OVER (PARTITION BY `a`.`product_seq` ORDER BY `a`.`seq` DESC) AS `row_num`
                  FROM `order_product_item` AS `a`
                  WHERE `a`.`product_seq` IN (?, …) AND `a`.`service_member_seq` = ? AND `a`.`is_close` = ? )
  AS `ranked` WHERE `ranked`.`row_num` <= 1
  link: {kind: one, parent_column: seq, child_column: product_seq}
```

- 왕복 7회(관계당 1쿼리). 공개 API에서 `multi_statement`를 제외하며 테스트가 순서가 지정된 단계와 정확한 문장 수를 검사한다.
- 부모가 0행이면 step 1~6은 실행하지 않는다(빈 IN 금지).
- 이 플랜은 값과 무관하게 형태가 고정이라 캐시된다. 사용자 `IN` 리스트 길이는 2의 거듭제곱 bucket으로 패딩되어 bucket마다 한 형태만 생긴다; 관계 단계의 IN은 `LIST_EXPAND` 슬롯이라 부모 행 수와 무관하게 캐시 히트.

## 동적 PHP 호출에서 정규 문법으로 줄어드는 것
- `->relation(ProductLang::query()->matchSeqWithProductSeq()->aliasLang())` → `->relationLang(...)`: 관계 방향·키·이름을 YAML이 알고 있으므로 두 토큰 삭제.
- `->and('(')` … 조인 안의 `->condition(')')` → `->and(fn($w) => … ->or()->brandLangAll(fn($b) => …))`: 괄호 위치·조인 선언 순서 무관, 조인 안 된 관계로 내려가면 컴파일 에러.
- `$productModels->and('(')` 를 체인 밖에서 나중에 호출하는 트릭 → 불필요.
- `Pagination::getList($model, recordsPerPage:…)` → `->using($db)->paginate($page, 20)`.
