import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { orm } from '../dist/index.js';
import { OrderProductItem, Product, ProductBrand, ProductBrandLang, ProductLang, ProductMatchCategory, ProductReview, User, connect } from '../dist/models/complex_query/models.js';
import { caseTest, DATABASE } from '../../../tests/testcase.mts';
import { mysqlConnection, postgresClient, withCaseDatabase } from './case-database.mjs';

const fixture = JSON.parse(await readFile(new URL('../../../contracts/fixtures/complex_query/complex_query.json', import.meta.url), 'utf8'));

async function seed(database, dialect) {
  let connection;
  let close;
  if (dialect === 'mysql') {
    connection = await mysqlConnection(database.dsn);
    close = () => connection.end();
  } else if (dialect === 'postgres') {
    connection = postgresClient(database.dsn);
    await connection.connect();
    close = () => connection.end();
  } else {
    connection = new DatabaseSync(database.path);
    close = () => connection.close();
  }
  try {
    for (const table of fixture.seed_order) {
      const columns = fixture.seed_columns[table];
      for (const row of fixture.seed[table]) {
        const values = columns.map(column => {
          if (!(column in row)) throw new Error(`seed ${table} omits column ${column}`);
          return row[column];
        });
        const marks = columns.map((_, i) => dialect === 'postgres' ? `$${i + 1}` : '?');
        const quote = dialect === 'mysql' ? name => `\`${name}\`` : name => `"${name}"`;
        const sql = `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${marks.join(', ')})`;
        if (dialect === 'postgres') await connection.query(sql, values);
        else if (dialect === 'mysql') await connection.execute(sql, values);
        else connection.prepare(sql).run(...values);
      }
    }
    if (dialect === 'mysql') {
      for (const sql of fixture.mysql_setup) await connection.execute(sql);
    }
  } finally {
    await close();
  }
}

function search(db, input) {
  const category = new ProductMatchCategory().removeAllColumns().serviceRegionCategoryItemSeq(input.category_seqs);
  const brandLang = new ProductBrandLang().removeAllColumns().fulltextBooleanNameWithDescription(input.keyword);
  const lang = new ProductLang().removeAllColumns().fulltextBooleanNameWithShortDescriptionWithContent(input.keyword);
  return new Product().connect(db)
    .relation(new ProductLang().matchSeqWithProductSeq().langId(input.lang_id).parentNode())
    .relation(new ProductBrand().matchProductBrandSeqWithSeq().aliasBrand()
      .relation(new ProductBrandLang().matchSeqWithProductBrandSeq().langId(input.lang_id).parentNode()))
    .relations(new ProductReview().matchSeqWithProductSeq().aliasReviews().isClose(false).orderBySeqDesc().groupLimit(3).keyNameSeq()
      .relation(new User().matchUserSeqWithSeq().aliasUser().removeAllColumns().addColumnName().addColumnProfileUrl()))
    .relation(new OrderProductItem().matchSeqWithProductSeq().aliasMyOrderItem().serviceMemberSeq(input.member_seq).andIsClose(false).orderBySeqDesc().groupLimit(1))
    .joinSeqWithProductSeq(category)
    .leftJoinProductBrandSeqWithProductBrandSeq(brandLang)
    .leftJoinSeqWithProductSeq(lang)
    .serviceSeq(input.service_seq).andIsClose(false).andIsDisplay(true)
    .and(q => q.isAllday(true).or(q => q.isAllday(false).andLeDisplayStartDt(orm.now()).andGeDisplayEndDt(orm.now())))
    .and(q => q.fulltextBooleanNameWithShortDescriptionWithContent(input.keyword).or(brandLang).or(lang))
    .groupBySeq().orderByLikeCountDescAndSeqDesc().getsPage(input.page, input.per_page);
}

function sequence(row, field) {
  return row === null || row === undefined ? null : row[`get${field}`]();
}

for (const dialect of ['mysql', 'postgres', 'sqlite']) caseTest(`complex_query_product_search/${dialect}`, DATABASE, async ({ step }) => {
  await withCaseDatabase(dialect, step, async database => {
    const db = await connect(database.dsn);
    try {
      await db.utils().schema().install();
      if (dialect !== 'sqlite') await seed(database, dialect);
      const events = [];
      const unsubscribe = db.subscribe(event => events.push({ kind: event.kind, tables: [...event.tables] }));
      let page;
      let failure;
      try { page = await search(db, fixture.input); } catch (error) { failure = error; }
      unsubscribe();
      if (dialect === 'sqlite') {
        assert.equal(failure?.code, fixture.expected_plan_steps.sqlite.error);
        assert.deepEqual(events, fixture.expected_events.sqlite);
        return;
      }
      if (failure !== undefined) throw failure;
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
    } finally {
      await db.close();
    }
  });
});
