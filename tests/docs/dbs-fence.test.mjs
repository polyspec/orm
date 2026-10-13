// The dbs fence of the documentation site (docs/.vitepress/dbs.ts, docs/editor.md "Ecosystem mechanisms"): the info
// string rules, the set of a page's fences keyed by declared name, the token spans, and a diagnostic failing the build.
//
// Usage: node --test tests/docs/dbs-fence.test.mjs (after the build of packages/orm-npm and packages/dbspec-language)
import assert from 'node:assert/strict';
import { caseTest } from '../testcase.mjs';
import { dbsFences, dbsInfo, renderDbs } from '../../docs/.vitepress/dbs.ts';

const TIMEOUT = 15000;
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const fence = (info, content, line) => ({ type: 'fence', info, content, map: [line, line + content.split('\n').length] });

const CORE = 'dbspec 1 core\n\ntable users {\n  id i64 identity\n  primary key (id)\n}\n';
const SHOP = 'dbspec 1 shop\n\nuse core { users }\n\ntable orders {\n  id i64 identity\n  user_id i64\n  primary key (id)\n  index ix_orders_user (user_id)\n  foreign key fk_orders_user (user_id) references users (id) on delete restrict on update restrict\n}\n';

caseTest('the info string accepts dbs alone and a set with its document', TIMEOUT, () => {
  assert.deepEqual(dbsInfo('dbs'), { set: null, document: null });
  assert.deepEqual(dbsInfo('dbs set=shop document=core'), { set: 'shop', document: 'core' });
  assert.equal(dbsInfo('text'), null);
  assert.equal(dbsInfo('mermaid'), null);
});

caseTest('a malformed dbs info string is an error', TIMEOUT, () => {
  for (const info of ['dbs set=shop', 'dbs document=core', 'dbs set=', 'dbs other=1', 'dbs set=a set=b document=c', 'dbs set']) {
    assert.throws(() => dbsInfo(info), /dbs fence info/, info);
  }
});

caseTest('a fence of a set reads the other fences of the page as its set', TIMEOUT, () => {
  const fences = dbsFences([fence('dbs set=shop document=core', CORE, 10), fence('dbs set=shop document=shop', SHOP, 20)]);
  const html = renderDbs(fences[1], fences, 'dbspec.md', escape);
  assert.match(html, /^<pre class="dbs" v-pre><code><span class="dbs-keyword">dbspec<\/span> <span class="dbs-number">1<\/span> <span class="dbs-name">shop<\/span>/);
  assert.match(html, /<span class="dbs-type">i64<\/span>/);
});

caseTest('a fence with a diagnostic fails with its page, line and rule', TIMEOUT, () => {
  const fences = dbsFences([fence('dbs set=shop document=shop', SHOP, 20)]);
  assert.throws(() => renderDbs(fences[0], fences, 'dbspec.md', escape), /dbspec\.md:24:5: use: /);
});

caseTest('a declared name that differs from the header fails through the use rule', TIMEOUT, () => {
  const fences = dbsFences([fence('dbs set=shop document=base', CORE, 10), fence('dbs set=shop document=shop', SHOP.replace('use core', 'use base'), 20)]);
  assert.throws(() => renderDbs(fences[1], fences, 'dbspec.md', escape), /: use: /);
});

caseTest('a set that declares one document twice is an error', TIMEOUT, () => {
  const fences = dbsFences([fence('dbs set=shop document=core', CORE, 1), fence('dbs set=shop document=core', CORE, 10), fence('dbs set=shop document=shop', SHOP, 20)]);
  assert.throws(() => renderDbs(fences[2], fences, 'dbspec.md', escape), /declares the document core twice/);
});

caseTest('text is escaped inside and between the spans', TIMEOUT, () => {
  const text = "dbspec 1 shop\n\n# a <comment> & more\ntable t {\n  id i64 identity\n  s varchar(8) default '<&>'\n  primary key (id)\n}\n";
  const fences = dbsFences([fence('dbs', text, 1)]);
  const html = renderDbs(fences[0], fences, 'dbspec.md', escape);
  assert.match(html, /<span class="dbs-comment"># a &lt;comment&gt; &amp; more<\/span>/);
  assert.match(html, /<span class="dbs-string">'&lt;&amp;&gt;'<\/span>/);
});
