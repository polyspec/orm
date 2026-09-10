# 복잡한 쿼리 예 — 상품 검색 목록 (plan-v2 문법)

example application patterns을 하나로 합친 시나리오:
- 루트 `product` — 서비스·노출 조건 + **노출 스케줄 OR 그룹** + **키워드 OR 검색(루트 + 조인 테이블 2개)**
- 카테고리 필터 **INNER JOIN** + `groupBySeq` (M:N 필터 관용구)
- 관계: `lang`(1:1, `parentNode`로 평탄화), `brand`(1:1) → 그 안의 `lang`(평탄화), `reviews`(1:N, **부모당 3개**, 각 리뷰의 `user` 1:1), `myOrderItem`(1:1, 로그인 사용자 것만, **부모당 1개**)
- 정렬 2키, 페이지네이션

YAML `relations:` (product):
```yaml
relations:
  lang:        {kind: one,  target: product_lang,       right: product_seq}
  brand:       {kind: one,  target: product_brand,      left: product_brand_seq, right: seq}
  reviews:     {kind: many, target: product_review,     right: product_seq}
  my_order_item: {kind: one, target: order_product_item, right: product_seq}
  categories:  {kind: many, target: product_match_category, right: product_seq}   # 조인에도 사용
```

## PHP
```php
$ga1 = (new ProductBrandLang)->alias('ga1');
$ga2 = (new ProductLang)->alias('ga2');

$page = (new Product)
    ->withLang((new ProductLang)->langId($langId)->parentNode())
    ->withBrand((new ProductBrand)
        ->withLang((new ProductBrandLang)->langId($langId)->parentNode()))
    ->withReviews((new ProductReview)
        ->isClose(0)->orderBySeqDesc()->groupLimit(3)->keyNameSeq()
        ->withUser((new User)->removeAllColumns()->addColumnName()->addColumnProfileUrl()))
    ->withMyOrderItem((new OrderProductItem)
        ->serviceMemberSeq($memberSeq)->isClose(0)->orderBySeqDesc()->groupLimit(1))
    ->joinCategories((new ProductMatchCategory)
        ->removeAllColumns()->inServiceModuleCategoryItemSeq($categorySeqs))
    ->leftJoin('ga1', Product::productBrandSeq()->cmp(ProductBrandLang::productBrandSeq()), $ga1)
    ->leftJoinLang($ga2)
    ->serviceSeq($serviceSeq)->isClose(0)->isDisplay(1)
    ->and(fn($w) => $w
        ->isAllday(1)
        ->or(fn($w) => $w->isAllday(0)->leDisplayStartDt($now)->geDisplayEndDt($now)))
    ->and(fn($w) => $w
        ->fulltextBooleanNameWithShortDescriptionWithContent($kw)
        ->orPred($ga1->cols()->fulltextBooleanNameWithDescription($kw))
        ->orPred($ga2->cols()->fulltextBooleanNameWithShortDescriptionWithContent($kw)))
    ->groupBySeq()
    ->orderByLikeCountDesc()->orderBySeqDesc()
    ->paginate($db, $pageNo, 20);

foreach ($page->items as $seq => $p) {
    $p->getName();                         // lang이 parentNode로 평탄화됨 → 루트 컬럼처럼
    $p->getBrand()?->getName();            // brand → brand.lang 평탄화
    foreach ($p->getReviews() as $reviewSeq => $r) { $r->getUser()->getName(); }
    $p->getMyOrderItem()?->getSeq();       // 없으면 null
}
$page->total; $page->pages;
```

## Go
```go
ga1 := m.NewProductBrandLang().Alias("ga1")
ga2 := m.NewProductLang().Alias("ga2")

page, err := m.NewProduct().
    WithLang(m.NewProductLang().LangId(langId).ParentNode()).
    WithBrand(m.NewProductBrand().
        WithLang(m.NewProductBrandLang().LangId(langId).ParentNode())).
    WithReviews(m.NewProductReview().
        IsClose(0).OrderBySeqDesc().GroupLimit(3).KeyNameSeq().
        WithUser(m.NewUser().RemoveAllColumns().AddColumnName().AddColumnProfileUrl())).
    WithMyOrderItem(m.NewOrderProductItem().
        ServiceMemberSeq(memberSeq).IsClose(0).OrderBySeqDesc().GroupLimit(1)).
    JoinCategories(m.NewProductMatchCategory().
        RemoveAllColumns().InServiceModuleCategoryItemSeq(categorySeqs)).
    LeftJoin("ga1", m.ProductCol.ProductBrandSeq.Cmp(m.ProductBrandLangCol.ProductBrandSeq), ga1).
    LeftJoinLang(ga2).
    ServiceSeq(serviceSeq).IsClose(0).IsDisplay(1).
    And(func(w *m.ProductWhere) { w.
        IsAllday(1).
        Or(func(w *m.ProductWhere) { w.IsAllday(0).LeDisplayStartDt(now).GeDisplayEndDt(now) }) }).
    And(func(w *m.ProductWhere) { w.
        FulltextBooleanNameWithShortDescriptionWithContent(kw).
        OrPred(ga1.Cols().FulltextBooleanNameWithDescription(kw)).
        OrPred(ga2.Cols().FulltextBooleanNameWithShortDescriptionWithContent(kw)) }).
    GroupBySeq().
    OrderByLikeCountDesc().OrderBySeqDesc().
    Paginate(ctx, db, pageNo, 20)

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
let ga1 = ProductBrandLang::new().alias("ga1");
let ga2 = ProductLang::new().alias("ga2");

let page = Product::new()
    .with_lang(ProductLang::new().lang_id(lang_id).parent_node())
    .with_brand(ProductBrand::new()
        .with_lang(ProductBrandLang::new().lang_id(lang_id).parent_node()))
    .with_reviews(ProductReview::new()
        .is_close(0).order_by_seq_desc().group_limit(3).key_name_seq()
        .with_user(User::new().remove_all_columns().add_column_name().add_column_profile_url()))
    .with_my_order_item(OrderProductItem::new()
        .service_member_seq(member_seq).is_close(0).order_by_seq_desc().group_limit(1))
    .join_categories(ProductMatchCategory::new()
        .remove_all_columns().in_service_module_category_item_seq(category_seqs))
    .left_join("ga1", Product::product_brand_seq().cmp(ProductBrandLang::product_brand_seq()), ga1.clone())
    .left_join_lang(ga2.clone())
    .service_seq(service_seq).is_close(0).is_display(1)
    .and(|w| w
        .is_allday(1)
        .or(|w| w.is_allday(0).le_display_start_dt(now).ge_display_end_dt(now)))
    .and(|w| w
        .fulltext_boolean_name_with_short_description_with_content(kw)
        .or_pred(ga1.cols().fulltext_boolean_name_with_description(kw))
        .or_pred(ga2.cols().fulltext_boolean_name_with_short_description_with_content(kw)))
    .group_by_seq()
    .order_by_like_count_desc().order_by_seq_desc()
    .paginate(&db, page_no, 20).await?;

for (seq, p) in &page.items {
    let _ = &p.name;
    let _ = p.brand().map(|b| &b.name);
    for (review_seq, r) in p.reviews() { let _ = r.user().map(|u| &u.name); }
    let _ = p.my_order_item().map(|o| o.seq);
}
let _ = page.total; let _ = page.pages;
```

세 블록은 줄 단위로 대응한다. 다른 곳은 언어 고정 접사뿐: `(new X)`/`m.NewX()`/`X::new()`, 클로저 머리(`fn($w) =>` / `func(w *m.ProductWhere) {` / `|w|`), 터미널 `paginate($db,…)` / `Paginate(ctx, db,…)` / `paginate(&db,…).await?`, 결과 접근의 null 처리(`?->` / nil-safe getter / `Option`).

## 엔진이 만드는 Plan (MySQL dialect)

```
step 0  query   (루트 + 조인)  ← paginate가 count 변형도 같이 요청
  SELECT a.seq, a.name, …(product 기본 컬럼), ga1.seq AS c31, …, ga2.name AS c40, …
  FROM `product` AS `a`
  INNER JOIN `product_match_category` AS `b` ON `a`.`seq` = `b`.`product_seq`
  LEFT  JOIN `product_brand_lang` AS `ga1` ON `a`.`product_brand_seq` = `ga1`.`product_brand_seq`
  LEFT  JOIN `product_lang` AS `ga2` ON `a`.`seq` = `ga2`.`product_seq`
  WHERE `a`.`service_seq` = ? AND `a`.`is_close` = ? AND `a`.`is_display` = ?
    AND (`b`.`service_module_category_item_seq` IN (?, ?, ?))                     -- 조인 그룹(AND)
    AND (`a`.`is_allday` = ? OR (`a`.`is_allday` = ? AND `a`.`display_start_dt` <= ? AND `a`.`display_end_dt` >= ?))
    AND (MATCH(`a`.`name`, `a`.`short_description`, `a`.`content`) AGAINST (? IN BOOLEAN MODE)
         OR MATCH(`ga1`.`name`, `ga1`.`description`) AGAINST (? IN BOOLEAN MODE)
         OR MATCH(`ga2`.`name`, `ga2`.`short_description`, `ga2`.`content`) AGAINST (? IN BOOLEAN MODE))
  GROUP BY `a`.`seq`
  ORDER BY `a`.`like_count` DESC, `a`.`seq` DESC
  LIMIT ?, ?
  binds: [service_seq, 0, 1, cat1, cat2, cat3, 1, 0, now, now, kw', kw', kw', offset, 20]
         (kw' = compatibility 규칙으로 "+w1 +w2*" 변환)

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

- 왕복 7회(compatibility도 동일: 관계당 1쿼리). `multi_statement` 옵션(S4)이면 step 1·2·4·6은 step 0 결과만 의존하므로 한 왕복으로 묶인다.
- 부모가 0행이면 step 1~6은 실행하지 않는다(빈 IN 금지).
- 이 플랜은 값과 무관하게 형태가 고정이라 캐시된다. 캐시 키에 `IN` 리스트 길이(카테고리 3개)가 포함된다; 관계 단계의 IN은 `LIST_EXPAND` 슬롯이라 부모 행 수와 무관하게 캐시 히트.

## compatibility 원문과 비교하면 사라지는 것
- `->relation((new ProductLang)->matchSeqWithProductSeq()->aliasLang())` → `->withLang(...)`: 관계 방향·키·이름을 YAML이 알고 있으므로 두 토큰 삭제.
- `->and('(')` … 조인 안의 `->condition(')')` → `->and(fn($w) => … ->orPred($ga1->cols()->…))`: 괄호 위치·조인 선언 순서 무관, 빠뜨리면 컴파일 에러.
- `$productModels->and('(')` 를 체인 밖에서 나중에 호출하는 트릭 → 불필요.
- `Pagination::getList($model, recordsPerPage:…)` → `->paginate($db, $page, 20)`.
