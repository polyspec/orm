<!-- doc-id: examples-complex-query -->
<!-- source-sha256: 67b1cfebb6e539e64f42df82132b20a606017d7903a393bb17a5c228fbecdb20 -->
# 복잡한 쿼리 예 — 상품 검색 목록

이 예는 [dsl.md](dsl.ko.md)의 문법을 사용하며 여러 관계와 조건 패턴을 함께 사용한다.
- 루트 `product`의 서비스·노출 조건, **노출 일정 OR 묶음**, **루트·브랜드 언어·상품 언어 행을 대상으로 한 키워드 OR 검색**
- 카테고리, 브랜드 언어, 상품 언어 필터는 `IN (SELECT …)` semijoin으로 적용해 페이지 조회 전에 상품 행이 중복되지 않는다. 검색은 모든 언어의 일치 행을 포함하지만 관계 로더는 요청한 `langId`를 선택한다.
- 관계: `product_lang`(1:1, `parentNode`로 병합), 병합한 `product_brand_lang`을 포함한 `product_brand`(1:1), 1:1 `user`를 포함한 `product_review`(1:N, **부모당 3개**), 로그인 회원의 `order_product_item`(1:1, **부모당 1개**)
- 정렬 키 2개와 페이지 목록

- **CPX-1** 관계 키는 `match<L>With<R>()`로 선택한다. `L`은 부모 컬럼, `R`은 자식 컬럼이다. 세 루트 필터는 컬럼 하나를 선택하는 `IN (SELECT …)` 모델을 사용하며 페이지 루트 쿼리에 필터 행을 조인하지 않는다.

## PHP
```php
$category = (new ProductMatchCategory)->removeAllColumns()->addColumnProductSeq()->serviceRegionCategoryItemSeq($categorySeqs);
$brandLang = (new ProductBrandLang)->removeAllColumns()->addColumnProductBrandSeq()->fulltextBooleanNameWithDescription($keyword);
$lang = (new ProductLang)->removeAllColumns()->addColumnProductSeq()->fulltextBooleanNameWithShortDescriptionWithContent($keyword);

$page = (new Product)->connect($slave1)
    ->relation((new ProductLang)->matchSeqWithProductSeq()->langId($langId)->parentNode())
    ->relation((new ProductBrand)->matchProductBrandSeqWithSeq()->aliasBrand()
        ->relation((new ProductBrandLang)->matchSeqWithProductBrandSeq()->langId($langId)->parentNode()))
    ->relations((new ProductReview)->matchSeqWithProductSeq()->aliasReviews()
        ->isClose(0)->orderBySeqDesc()->groupLimit(3)->keyNameSeq()
        ->relation((new User)->matchUserSeqWithSeq()->aliasUser()
            ->removeAllColumns()->addColumnName()->addColumnProfileUrl()))
    ->relation((new OrderProductItem)->matchSeqWithProductSeq()->aliasMyOrderItem()
        ->serviceMemberSeq($memberSeq)->andIsClose(0)->orderBySeqDesc()->groupLimit(1))
    ->seq($category)
    ->and()->serviceSeq($serviceSeq)->andIsClose(0)->andIsDisplay(1)
    ->and(fn (Product $q) => $q
        ->isAllday(1)
        ->or(fn (Product $q) => $q->isAllday(0)->andLeDisplayStartDt(Orm::now())->andGeDisplayEndDt(Orm::now())))
    ->and(fn (Product $q) => $q
        ->fulltextBooleanNameWithShortDescriptionWithContent($keyword)
        ->or(fn (Product $q) => $q->productBrandSeq($brandLang))
        ->or(fn (Product $q) => $q->seq($lang)))
    ->orderByLikeCountDescAndSeqDesc()
    ->getsPage($pageNo, 20);

foreach ($page->items as $seq => $p) {
    $p->getName();                         // product_lang columns merged by parentNode
    $p->getBrand()?->getName();            // brand with merged brand language columns
    foreach ($p->getReviews() as $reviewSeq => $r) { $r->getUser()->getName(); }
    $p->getMyOrderItem()?->getSeq();       // null when absent
}
$page->totalCount; $page->totalPages;
```

## Go
```go
category := model.ProductMatchCategory().RemoveAllColumns().AddColumnProductSeq().ServiceRegionCategoryItemSeq(categorySeqs)
brandLang := model.ProductBrandLang().RemoveAllColumns().AddColumnProductBrandSeq().FulltextBooleanNameWithDescription(keyword)
lang := model.ProductLang().RemoveAllColumns().AddColumnProductSeq().FulltextBooleanNameWithShortDescriptionWithContent(keyword)

page, err := model.Product().Connect(slave1).
    Relation(model.ProductLang().MatchSeqWithProductSeq().LangId(langId).ParentNode()).
    Relation(model.ProductBrand().MatchProductBrandSeqWithSeq().AliasBrand().
        Relation(model.ProductBrandLang().MatchSeqWithProductBrandSeq().LangId(langId).ParentNode())).
    Relations(model.ProductReview().MatchSeqWithProductSeq().AliasReviews().
        IsClose(false).OrderBySeqDesc().GroupLimit(3).KeyNameSeq().
        Relation(model.User().MatchUserSeqWithSeq().AliasUser().
            RemoveAllColumns().AddColumnName().AddColumnProfileUrl())).
    Relation(model.OrderProductItem().MatchSeqWithProductSeq().AliasMyOrderItem().
        ServiceMemberSeq(memberSeq).AndIsClose(false).OrderBySeqDesc().GroupLimit(1)).
    Seq(category).
    And().ServiceSeq(serviceSeq).AndIsClose(false).AndIsDisplay(true).
    And(func(q *model.ProductModel) {
        q.IsAllday(true).Or(func(q *model.ProductModel) {
            q.IsAllday(false).AndLeDisplayStartDt(orm.Now()).AndGeDisplayEndDt(orm.Now())
        })
    }).
    And(func(q *model.ProductModel) {
        q.FulltextBooleanNameWithShortDescriptionWithContent(keyword)
        q.Or(func(q *model.ProductModel) { q.ProductBrandSeq(brandLang) })
        q.Or(func(q *model.ProductModel) { q.Seq(lang) })
    }).
    OrderByLikeCountDescAndSeqDesc().
    GetsPage(pageNo, 20)

if err := func() error {
    for seq, p := range page.Items.All() {
        _ = seq
        name, err := p.GetName()
        if err != nil { return err }
        _ = name
        brand, err := p.GetBrand()
        if err != nil { return err }
        if brand != nil {
            brandName, err := brand.GetName()
            if err != nil { return err }
            _ = brandName
        }
        reviews, err := p.GetReviews()
        if err != nil { return err }
        for reviewSeq, r := range reviews.All() {
            _ = reviewSeq
            user, err := r.GetUser()
            if err != nil { return err }
            if user != nil {
                userName, err := user.GetName()
                if err != nil { return err }
                _ = userName
            }
        }
        item, err := p.GetMyOrderItem()
        if err != nil { return err }
        if item != nil {
            itemSeq, err := item.GetSeq()
            if err != nil { return err }
            _ = itemSeq
        }
    }
    return nil
}(); err != nil {
    return err
}
_ = page.TotalCount; _ = page.TotalPages
```

## Rust
```rust
let category = ProductMatchCategory::new().remove_all_columns().add_column_product_seq().service_region_category_item_seq(category_seqs);
let brand_lang = ProductBrandLang::new().remove_all_columns().add_column_product_brand_seq().fulltext_boolean_name_with_description(&keyword);
let lang = ProductLang::new().remove_all_columns().add_column_product_seq().fulltext_boolean_name_with_short_description_with_content(&keyword);

let page = Product::new().connect(&slave1)
    .relation(ProductLang::new().match_seq_with_product_seq().lang_id(lang_id).parent_node())
    .relation(ProductBrand::new().match_product_brand_seq_with_seq().alias_brand()
        .relation(ProductBrandLang::new().match_seq_with_product_brand_seq().lang_id(lang_id).parent_node()))
    .relations(ProductReview::new().match_seq_with_product_seq().alias_reviews()
        .is_close(false).order_by_seq_desc().group_limit(3).key_name_seq()
        .relation(User::new().match_user_seq_with_seq().alias_user()
            .remove_all_columns().add_column_name().add_column_profile_url()))
    .relation(OrderProductItem::new().match_seq_with_product_seq().alias_my_order_item()
        .service_member_seq(member_seq).and_is_close(false).order_by_seq_desc().group_limit(1))
    .seq(&category)
    .and().service_seq(service_seq).and_is_close(false).and_is_display(true)
    .and(|q| q
        .is_allday(true)
        .or(|q| q.is_allday(false).and_le_display_start_dt(polyspec_orm::now()).and_ge_display_end_dt(polyspec_orm::now())))
    .and(|q| q
        .fulltext_boolean_name_with_short_description_with_content(&keyword)
        .or(|q| q.product_brand_seq(&brand_lang))
        .or(|q| q.seq(&lang)))
    .order_by_like_count_desc_and_seq_desc()
    .gets_page(page_no, 20).await?;

for (seq, p) in &page.items {
    let _ = &p.name;
    let _ = p.brand().map(|b| &b.name);
    for (review_seq, r) in p.reviews() { let _ = r.user().map(|u| &u.name); }
    let _ = p.my_order_item().map(|o| o.seq);
}
let _ = page.total_count; let _ = page.total_pages;
```

세 블록은 줄 단위로 대응한다. 나머지 차이는 언어 형태다. 생성은 `new Product`, `model.Product()`, `Product::new()`이고, 묶음 콜백 머리는 `fn (Product $q) =>`, `func(q *model.ProductModel) {`, `|q|`이며, 결과가 없을 때는 `?->`, nil 안전 getter, `Option`으로 처리한다.

## 엔진이 만드는 Plan (MySQL dialect)

```
step 0  query   (root with three IN subqueries; no filter joins or grouping)
  SELECT a.seq, a.name, …(default product columns)
  FROM `product` AS `a`
  WHERE `a`.`seq` IN (SELECT `s1`.`product_seq` FROM `product_match_category` AS `s1`
                      WHERE `s1`.`service_region_category_item_seq` IN (?, ?, ?, ?))
    AND `a`.`service_seq` = ? AND `a`.`is_close` = ? AND `a`.`is_display` = ?
    AND (`a`.`is_allday` = ? OR (`a`.`is_allday` = ? AND `a`.`display_start_dt` <= NOW(6) AND `a`.`display_end_dt` >= NOW(6)))
    AND (MATCH(`a`.`name`, `a`.`short_description`, `a`.`content`) AGAINST (? IN BOOLEAN MODE)
         OR `a`.`product_brand_seq` IN (SELECT `s2`.`product_brand_seq` FROM `product_brand_lang` AS `s2`
                                        WHERE MATCH(`s2`.`name`, `s2`.`description`) AGAINST (? IN BOOLEAN MODE))
         OR `a`.`seq` IN (SELECT `s3`.`product_seq` FROM `product_lang` AS `s3`
                          WHERE MATCH(`s3`.`name`, `s3`.`short_description`, `s3`.`content`) AGAINST (? IN BOOLEAN MODE)))
  ORDER BY `a`.`like_count` DESC, `a`.`seq` DESC
  LIMIT ?, ?
  binds: [cat1, cat2, cat3, cat3, service_seq, 0, 1, 1, 0, kw', kw', kw', offset, 20]
         (kw' = keyword converted by the boolean full-text rule to "+w1 +w2*")

step 0c count  SELECT COUNT(*) FROM `product` AS `a` WHERE … same conditions (without ORDER/LIMIT), requested by getsPage

step 1  query   product_lang (ONE, parent_node)    bind_from: step0.seq (dedup)
  SELECT `a`.`seq`, `a`.`product_seq`, `a`.`name`, … FROM `product_lang` AS `a`
  WHERE `a`.`product_seq` IN (?, …) AND `a`.`lang_id` = ?
  link: {kind: one, parent_column: seq, child_column: product_seq, parent_node: true}

step 2  query   brand (ONE)                         bind_from: step0.product_brand_seq
  SELECT … FROM `product_brand` AS `a` WHERE `a`.`seq` IN (?, …)
  link: {kind: one, parent_column: product_brand_seq, child_column: seq}

step 3  query   brand.product_brand_lang (ONE, parent_node)  bind_from: step2.seq
  SELECT … FROM `product_brand_lang` AS `a` WHERE `a`.`product_brand_seq` IN (?, …) AND `a`.`lang_id` = ?
  link: {parent: step2, kind: one, parent_node: true}

step 4  query   reviews (MANY, group_limit 3)       bind_from: step0.seq
  SELECT * FROM (
    SELECT `a`.`seq`, `a`.`product_seq`, …,
           ROW_NUMBER() OVER (PARTITION BY `a`.`product_seq` ORDER BY `a`.`seq` DESC) AS `row_num`
    FROM `product_review` AS `a`
    WHERE `a`.`product_seq` IN (?, …) AND `a`.`is_close` = ?
  ) AS `ranked` WHERE `ranked`.`row_num` <= 3
  ORDER BY `ranked`.`seq` DESC
  link: {kind: many, parent_column: seq, child_column: product_seq, key_column: seq}   -- row_num is removed during assembly

step 5  query   reviews.user (ONE)                  bind_from: step4.user_seq
  SELECT `a`.`seq`, `a`.`name`, `a`.`profile_url` FROM `user` AS `a` WHERE `a`.`seq` IN (?, …)
  link: {parent: step4, kind: one, parent_column: user_seq, child_column: seq}

step 6  query   my_order_item (ONE, group_limit 1)  bind_from: step0.seq
  SELECT * FROM ( SELECT …, ROW_NUMBER() OVER (PARTITION BY `a`.`product_seq` ORDER BY `a`.`seq` DESC) AS `row_num`
                  FROM `order_product_item` AS `a`
                  WHERE `a`.`product_seq` IN (?, …) AND `a`.`service_member_seq` = ? AND `a`.`is_close` = ? )
  AS `ranked` WHERE `ranked`.`row_num` <= 1
  link: {kind: one, parent_column: seq, child_column: product_seq}
```

- **CPX-2** 문장은 8개다. 페이지 행 쿼리, 페이지 개수 쿼리, 관계마다 쿼리 하나를 실행한다. 행 쿼리와 개수 쿼리는 같은 semijoin 필터를 쓴다. 공개 API는 `multi_statement`를 제외한다. fixture `contracts/fixtures/complex_query`는 이 예제를 모든 구현이 MySQL, PostgreSQL, SQLite에서 실행하는 case로 정한다: schema `complex_query.dbs`, 그리고 `complex_query.json`의 seed, 입력, 페이지 결과, 순서 있는 plan 단계와 database별 statement event다. MySQL과 PostgreSQL에서 검색은 정확히 그 8개 문장을 그 순서로 실행하고 그 페이지를 돌려준다. full-text 연산자가 없는 SQLite에서는 어떤 문장보다 먼저 `OPERATOR_NOT_ALLOWED`로 거부된다.
- **CPX-3** 부모 행이 0개이면 1~6단계를 실행하지 않는다. 빈 IN 목록은 허용하지 않는다.
- **CPX-4** 이 Plan은 값과 무관하게 형태가 고정되어 캐시된다. 사용자 `IN` 목록 길이는 2의 거듭제곱 bucket으로 채워 bucket마다 형태가 하나다. 관계 단계의 IN은 `LIST_EXPAND` 슬롯을 사용하므로 부모 행 수와 무관하게 캐시를 재사용한다.
- **CPX-5** 한 질의에서 alias 없이 같은 자식 entity의 relation 두 개는 같은 결과 이름을 가지며, 그 질의는 `CONFIG`로 거부된다. 메시지는 그 결과 이름 `<x>_model`(many relation이면 `<x>_models`)과 alias 호출 `alias<Name>()`을 모든 구현에서 명시한다. 예: `relation user_model is used twice; call alias<Name>() on one of them, such as aliasWriter()`.
