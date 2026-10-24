import { readFile } from 'node:fs/promises';
import { orm } from '../dist/index.js';
import { OrderProductItem, Product, ProductBrand, ProductBrandLang, ProductLang, ProductMatchCategory, ProductReview, User } from '../dist/models/complex_query/models.js';

export const fixture = JSON.parse(await readFile(new URL('../../../contracts/fixtures/complex_query/complex_query.json', import.meta.url), 'utf8'));

export function buildSearch(input, db) {
  const category = new ProductMatchCategory().removeAllColumns().addColumnProductSeq().serviceRegionCategoryItemSeq(input.category_seqs);
  const brandLang = new ProductBrandLang().removeAllColumns().addColumnProductBrandSeq().fulltextBooleanNameWithDescription(input.keyword);
  const lang = new ProductLang().removeAllColumns().addColumnProductSeq().fulltextBooleanNameWithShortDescriptionWithContent(input.keyword);
  const root = new Product();
  if (db !== undefined) root.connect(db);
  return root
    .relation(new ProductLang().matchSeqWithProductSeq().langId(input.lang_id).parentNode())
    .relation(new ProductBrand().matchProductBrandSeqWithSeq().aliasBrand()
      .relation(new ProductBrandLang().matchSeqWithProductBrandSeq().langId(input.lang_id).parentNode()))
    .relations(new ProductReview().matchSeqWithProductSeq().aliasReviews().isClose(false).orderBySeqDesc().groupLimit(3).keyNameSeq()
      .relation(new User().matchUserSeqWithSeq().aliasUser().removeAllColumns().addColumnName().addColumnProfileUrl()))
    .relation(new OrderProductItem().matchSeqWithProductSeq().aliasMyOrderItem().serviceMemberSeq(input.member_seq).andIsClose(false).orderBySeqDesc().groupLimit(1))
    .seq(category)
    .and(q => q.serviceSeq(input.service_seq)).andIsClose(false).andIsDisplay(true)
    .and(q => q.isAllday(true).or(q => q.isAllday(false).andLeDisplayStartDt(orm.now()).andGeDisplayEndDt(orm.now())))
    .and(q => q.fulltextBooleanNameWithShortDescriptionWithContent(input.keyword)
      .or(q => q.productBrandSeq(brandLang))
      .or(q => q.seq(lang)))
    .orderByLikeCountDescAndSeqDesc();
}

export function search(db, input) {
  return buildSearch(input, db).getsPage(input.page, input.per_page);
}

function sequence(row, field) {
  return row === null || row === undefined ? null : row[`get${field}`]();
}

export function assertSearchResult(assert, page, events, dialect) {
  assert.equal(page.totalCount, fixture.expected.total_count);
  assert.equal(page.totalPages, fixture.expected.total_pages);
  const products = page.items.values();
  assert.deepEqual(products.map(product => product.getSeq()), fixture.expected.row_seqs);
  for (const product of products) {
    const productSeq = product.getSeq();
    const key = String(productSeq);
    assert.equal(sequence(product.getProductLangModel(), 'Seq'), fixture.expected.product_lang_seqs[key] ?? null);
    const brand = product.getBrand();
    const brandSeq = sequence(brand, 'Seq');
    assert.equal(brandSeq, fixture.expected.brand_seqs[key] ?? null);
    if (brand !== null) {
      assert.equal(sequence(brand.getProductBrandLangModel(), 'Seq'), fixture.expected.brand_lang_seqs[String(brandSeq)] ?? null);
    }
    const reviews = product.getReviews().values();
    assert.deepEqual(reviews.map(review => review.getSeq()), fixture.expected.review_seqs[key] ?? []);
    for (const review of reviews) {
      assert.equal(sequence(review.getUser(), 'Seq'), fixture.expected.review_user_seqs[String(review.getSeq())] ?? null);
    }
    assert.equal(sequence(product.getMyOrderItem(), 'Seq'), fixture.expected.order_product_item_seqs[key] ?? null);
  }
  assert.deepEqual(events, fixture.expected_events[dialect]);
  assert.equal(events.length, 8);
}
