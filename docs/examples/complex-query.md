# Complex query example — product search list

This example uses the syntax in [dsl.md](../dsl.md). It combines several relation and condition patterns:
- Root `product` with service and display conditions, a **display schedule OR group**, and a **keyword OR search across the root and two joined tables**
- Category filter with an **INNER JOIN** and `groupBySeq` (M:N filter pattern)
- Relations: `product_lang` (1:1, merged with `parentNode`), `product_brand` (1:1) with a nested merged `product_brand_lang`, `product_review` (1:N, **three per parent**) with a 1:1 `user`, and `order_product_item` for the signed-in member (1:1, **one per parent**)
- Two-key ordering and page listing

Relation keys are selected with `match<L>With<R>()`, where `L` is the parent column and `R` is the child column. Join children are configured before they are passed to the join method.

## PHP
```php
$category = (new ProductMatchCategory)->removeAllColumns()->serviceModuleCategoryItemSeq($categorySeqs);
$brandLang = (new ProductBrandLang)->removeAllColumns()->fulltextBooleanNameWithDescription($keyword);
$lang = (new ProductLang)->removeAllColumns()->fulltextBooleanNameWithShortDescriptionWithContent($keyword);

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
    ->joinSeqWithProductSeq($category)
    ->leftJoinProductBrandSeqWithProductBrandSeq($brandLang)
    ->leftJoinSeqWithProductSeq($lang)
    ->serviceSeq($serviceSeq)->andIsClose(0)->andIsDisplay(1)
    ->and(fn (Product $q) => $q
        ->isAllday(1)
        ->or(fn (Product $q) => $q->isAllday(0)->andLeDisplayStartDt(Orm::now())->andGeDisplayEndDt(Orm::now())))
    ->and(fn (Product $q) => $q
        ->fulltextBooleanNameWithShortDescriptionWithContent($keyword)
        ->or($brandLang)
        ->or($lang))
    ->groupBySeq()
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
category := model.ProductMatchCategory().RemoveAllColumns().ServiceModuleCategoryItemSeq(categorySeqs)
brandLang := model.ProductBrandLang().RemoveAllColumns().FulltextBooleanNameWithDescription(keyword)
lang := model.ProductLang().RemoveAllColumns().FulltextBooleanNameWithShortDescriptionWithContent(keyword)

page, err := model.Product().Connect(slave1).
    Relation(model.ProductLang().MatchSeqWithProductSeq().LangId(langId).ParentNode()).
    Relation(model.ProductBrand().MatchProductBrandSeqWithSeq().AliasBrand().
        Relation(model.ProductBrandLang().MatchSeqWithProductBrandSeq().LangId(langId).ParentNode())).
    Relations(model.ProductReview().MatchSeqWithProductSeq().AliasReviews().
        IsClose(0).OrderBySeqDesc().GroupLimit(3).KeyNameSeq().
        Relation(model.User().MatchUserSeqWithSeq().AliasUser().
            RemoveAllColumns().AddColumnName().AddColumnProfileUrl())).
    Relation(model.OrderProductItem().MatchSeqWithProductSeq().AliasMyOrderItem().
        ServiceMemberSeq(memberSeq).AndIsClose(0).OrderBySeqDesc().GroupLimit(1)).
    JoinSeqWithProductSeq(category).
    LeftJoinProductBrandSeqWithProductBrandSeq(brandLang).
    LeftJoinSeqWithProductSeq(lang).
    ServiceSeq(serviceSeq).AndIsClose(0).AndIsDisplay(1).
    And(func(q *model.ProductModel) {
        q.IsAllday(1).Or(func(q *model.ProductModel) {
            q.IsAllday(0).AndLeDisplayStartDt(orm.Now()).AndGeDisplayEndDt(orm.Now())
        })
    }).
    And(func(q *model.ProductModel) {
        q.FulltextBooleanNameWithShortDescriptionWithContent(keyword).Or(brandLang).Or(lang)
    }).
    GroupBySeq().
    OrderByLikeCountDescAndSeqDesc().
    GetsPage(pageNo, 20)

for seq, p := range page.Items.All() {
    _ = p.GetName()
    _ = p.GetBrand().GetName()                  // nil-safe getter chain
    for reviewSeq, r := range p.GetReviews().All() { _ = r.GetUser().GetName() }
    _ = p.GetMyOrderItem().GetSeq()             // zero value when absent
}
_ = page.TotalCount; _ = page.TotalPages
```

## Rust
```rust
let category = ProductMatchCategory::new().remove_all_columns().service_module_category_item_seq(category_seqs);
let brand_lang = ProductBrandLang::new().remove_all_columns().fulltext_boolean_name_with_description(&keyword);
let lang = ProductLang::new().remove_all_columns().fulltext_boolean_name_with_short_description_with_content(&keyword);

let page = Product::new().connect(&slave1)
    .relation(ProductLang::new().match_seq_with_product_seq().lang_id(lang_id).parent_node())
    .relation(ProductBrand::new().match_product_brand_seq_with_seq().alias_brand()
        .relation(ProductBrandLang::new().match_seq_with_product_brand_seq().lang_id(lang_id).parent_node()))
    .relations(ProductReview::new().match_seq_with_product_seq().alias_reviews()
        .is_close(0).order_by_seq_desc().group_limit(3).key_name_seq()
        .relation(User::new().match_user_seq_with_seq().alias_user()
            .remove_all_columns().add_column_name().add_column_profile_url()))
    .relation(OrderProductItem::new().match_seq_with_product_seq().alias_my_order_item()
        .service_member_seq(member_seq).and_is_close(0).order_by_seq_desc().group_limit(1))
    .join_seq_with_product_seq(&category)
    .left_join_product_brand_seq_with_product_brand_seq(&brand_lang)
    .left_join_seq_with_product_seq(&lang)
    .service_seq(service_seq).and_is_close(0).and_is_display(1)
    .and(|q| q
        .is_allday(1)
        .or(|q| q.is_allday(0).and_le_display_start_dt(orm::now()).and_ge_display_end_dt(orm::now())))
    .and(|q| q
        .fulltext_boolean_name_with_short_description_with_content(&keyword)
        .or(&brand_lang)
        .or(&lang))
    .group_by_seq()
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

The three blocks correspond line by line. The remaining differences are language forms: `new Product`, `model.Product()`, and `Product::new()`; group callback headers `fn (Product $q) =>`, `func(q *model.ProductModel) {`, and `|q|`; and absent-result handling with `?->`, nil-safe getters, and `Option`.

## Plan produced by the engine (MySQL dialect)

```
step 0  query   (root + joins)
  SELECT a.seq, a.name, …(default product columns)   -- join children keep only PK/FK columns
  FROM `product` AS `a`
  INNER JOIN `product_match_category` AS `b` ON `a`.`seq` = `b`.`product_seq`
  LEFT  JOIN `product_brand_lang` AS `c` ON `a`.`product_brand_seq` = `c`.`product_brand_seq`
  LEFT  JOIN `product_lang` AS `d` ON `a`.`seq` = `d`.`product_seq`
  WHERE `a`.`service_seq` = ? AND `a`.`is_close` = ? AND `a`.`is_display` = ?
    AND (`a`.`is_allday` = ? OR (`a`.`is_allday` = ? AND `a`.`display_start_dt` <= NOW() AND `a`.`display_end_dt` >= NOW()))
    AND (MATCH(`a`.`name`, `a`.`short_description`, `a`.`content`) AGAINST (? IN BOOLEAN MODE)
         OR (MATCH(`c`.`name`, `c`.`description`) AGAINST (? IN BOOLEAN MODE))
         OR (MATCH(`d`.`name`, `d`.`short_description`, `d`.`content`) AGAINST (? IN BOOLEAN MODE)))
    AND `b`.`service_module_category_item_seq` IN (?, ?, ?)       -- category child conditions not passed to a group
  GROUP BY `a`.`seq`
  ORDER BY `a`.`like_count` DESC, `a`.`seq` DESC
  LIMIT ?, ?
  binds: [service_seq, 0, 1, 1, 0, kw', kw', kw', cat1, cat2, cat3, offset, 20]
         (kw' = keyword converted by the boolean full-text rule to "+w1 +w2*")

step 0c count  SELECT COUNT(DISTINCT `a`.`seq`) FROM … same JOIN/WHERE (without ORDER/LIMIT), requested by getsPage

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

- Eight statements: the page row query, the page count query, and one query per relation. The public API excludes `multi_statement`; tests verify the ordered steps and exact statement count.
- Steps 1 through 6 do not run when the parent has zero rows. Empty IN lists are prohibited.
- This plan has a fixed shape independent of values and is cached. User `IN` list lengths are padded to power-of-two buckets, so each bucket has one shape; relation-stage IN uses a `LIST_EXPAND` slot and remains a cache hit regardless of parent row count.
