'use strict';

/**
 * /api/search の制御フロー（「検索が遅すぎる」修正）のテスト
 *
 * 旧実装の問題:
 *   1. 高速経路1段3.5秒 × 最大3段 + 従来経路4秒で、最長≈14秒待たされていた
 *   2. 高速経路が上流に到達できていないのに（ブロック環境）、
 *      必ずしも失敗する従来経路（スクレイピング）まで繋げて4秒待っていた
 *   3. フロントは検索結果が12件未満だと別カテゴリの動画を混ぜてシャッフル
 *      （＝「検索結果が検索語と合わない」）
 *
 * index.js は起動時にサーバを張るので、ハンドラ本体を切り出して
 * 依存（fastMeta / legacySearch など）をスタブで注入して検証する。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'index.js');
const HOME = path.join(__dirname, '..', 'public', 'home.html');

/* ------------------------------------------------------------ ハーネス */

/** index.js から /api/search ハンドラだけ切り出して関数として返す */
function loadHandler(deps = {}) {
  const src = fs.readFileSync(INDEX, 'utf8');
  const from = src.indexOf('app.get("/api/search"');
  const to = src.indexOf('app.get("/api/recommendations"');
  assert.ok(from > 0 && to > from, '/api/search ハンドラが見つかる');
  const end = src.lastIndexOf('});', to);
  assert.ok(end > from, 'ハンドラ終端が見つかる');
  let code = src.slice(from, end + 3);
  code = code.replace(/^app\.get\("\/api\/search", /, 'const handler = ').replace(/\}\);$/, '};');

  const {
    fastMeta = null,
    legacySearch = null,
    ytMeta = { isBlocked: false, state: () => ({ transportFailures: 0 }) },
    YT_META_ENABLED = true,
    filtersFromQuery,
    buildSearchParams,
    process: proc,
  } = deps;
  const { filtersFromQuery: realFilters, buildSearchParams: realSp } = require('../lib/search-filters');

  const factory = new Function(
    'fastMeta', 'legacySearch', 'mergeItems', 'ytMeta', 'YT_META_ENABLED',
    'filtersFromQuery', 'buildSearchParams', 'process',
    `${code}; return handler;`
  );
  return factory(
    fastMeta, legacySearch,
    (a, b) => [...(a || []), ...(b || [])]
      .filter((x, i, arr) => x && x.id && arr.findIndex((y) => y.id === x.id) === i)
      .slice(0, 60),
    ytMeta, YT_META_ENABLED,
    filtersFromQuery || realFilters,
    buildSearchParams || realSp,
    proc || process
  );
}

/** 指定の timeout を必ず使い切る fastMeta スタブ（＝上流が最も遅いケース） */
function makeFastMeta(script) {
  const calls = [];
  const fn = async (name, _attempt, _fallback, opts = {}) => {
    calls.push({ name, timeout: opts.timeout, keepEmpty: !!opts.keepEmpty });
    await new Promise((r) => setTimeout(r, opts.timeout));
    return script(calls.length - 1, calls);
  };
  fn.calls = calls;
  return fn;
}

/** 指定 timeout まで待って結果を返す（またはハングして[]）legacySearch スタブ */
function makeLegacy(items, { hang = false } = {}) {
  const calls = [];
  const fn = async (_q, _limit, _page, timeoutMs) => {
    calls.push({ timeoutMs });
    if (hang) await new Promise((r) => setTimeout(r, Math.min(timeoutMs || 4000, 4000)));
    return items;
  };
  fn.calls = calls;
  return fn;
}

function makeRes() {
  const res = { code: 200, body: null, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
  return res;
}

async function run(handler, req, env) {
  const res = makeRes();
  await handler(req, res);
  return res;
}

/* ------------------------------------------------------------------ テスト */

test('高速経路に到達できない（ブロック環境）ときは従来経路を呼ばない（4秒の無駄待ちを消す）', async () => {
  const fastMeta = makeFastMeta(() => null); // 毎回 timeout を使い切って失敗
  const legacy = makeLegacy([]);
  const handler = loadHandler({ fastMeta, legacySearch: legacy, process: { env: { YT_SEARCH_BUDGET: '900', YT_SEARCH_TIMEOUT: '300' } } });

  const started = Date.now();
  const res = await run(handler, { query: { q: 'abc' } });
  const elapsed = Date.now() - started;

  assert.deepStrictEqual(res.body.items, []);
  assert.strictEqual(res.body.source, 'none');
  assert.strictEqual(fastMeta.calls.length, 1, '到達しないのに2回再挑戦しない');
  assert.strictEqual(legacy.calls.length, 0, '上流に到達できていないのに従来経路を呼ばない');
  assert.ok(elapsed < 800, `予算内で返す（${elapsed}ms < 800ms）`);
});

test('高速経路が失敗しても、予算が残っていればプロキシ再挑戦は1回だけ（段が積み上がらない）', async () => {
  const fastMeta = makeFastMeta(() => null);
  const legacy = makeLegacy([]);
  const ytMeta = { isBlocked: false, state: () => ({ transportFailures: 3 }) };
  const handler = loadHandler({
    fastMeta, legacySearch: legacy, ytMeta,
    process: { env: { YT_SEARCH_BUDGET: '1500', YT_SEARCH_TIMEOUT: '400' } },
  });

  const res = await run(handler, { query: { q: 'abc' } });
  assert.deepStrictEqual(res.body.items, []);
  // 初回(400ms) + 再挑戦(400ms) のみ。3段目・従来経路は予算不足／到達不可で走らない
  assert.strictEqual(fastMeta.calls.length, 2, '再挑戦は1回だけ');
  assert.strictEqual(legacy.calls.length, 0, '従来経路は呼ばない');
  assert.ok(res.body.source === 'none' || res.body.source === 'error');
});

test('高速経路が少なければ従来経路で補う（残りは従来どおり）', async () => {
  const fastMeta = makeFastMeta(() => ({ items: [{ id: '1' }, { id: '2' }] }));
  const legacy = makeLegacy([{ id: '3' }]);
  const handler = loadHandler({ fastMeta, legacySearch: legacy, process: { env: { YT_SEARCH_BUDGET: '6000', YT_SEARCH_TIMEOUT: '100' } } });

  const res = await run(handler, { query: { q: 'abc' } });
  assert.deepStrictEqual(res.body.items.map((i) => i.id), ['1', '2', '3']);
  assert.strictEqual(res.body.source, 'mixed');
  assert.strictEqual(legacy.calls.length, 1, '少なければ従来経路で補う');
});

test('高速経路が到達して0件なら従来経路で補う余地は残す（0件＝到達済み）', async () => {
  const fastMeta = makeFastMeta(() => ({ items: [] }));
  const legacy = makeLegacy([{ id: 'x' }]);
  const handler = loadHandler({ fastMeta, legacySearch: legacy, process: { env: { YT_SEARCH_BUDGET: '6000', YT_SEARCH_TIMEOUT: '100' } } });

  const res = await run(handler, { query: { q: 'abc' } });
  assert.strictEqual(legacy.calls.length, 1, '到達済み0件は従来経路で補える');
  assert.deepStrictEqual(res.body.items.map((i) => i.id), ['x']);
});

test('従来経路には残り予算を渡す（4秒フル待ちはしない）', async () => {
  const fastMeta = makeFastMeta(() => ({ items: [{ id: '1' }] }));
  const legacy = makeLegacy([]);
  const handler = loadHandler({ fastMeta, legacySearch: legacy, process: { env: { YT_SEARCH_BUDGET: '1000', YT_SEARCH_TIMEOUT: '200' } } });

  await run(handler, { query: { q: 'abc' } });
  assert.strictEqual(legacy.calls.length, 1);
  assert.ok(legacy.calls[0].timeoutMs <= 1000, `従来経路の待ちは残り予算以内に切られる（${legacy.calls[0].timeoutMs}ms）`);
});

test('絞り込みで0件なら絞り込みなしで再検索し、告知を返す', async () => {
  let call = 0;
  const fastMeta = makeFastMeta(() => {
    call += 1;
    return call === 1 ? { items: [] } : { items: Array.from({ length: 10 }, (_, i) => ({ id: String(i) })) };
  });
  const legacy = makeLegacy([]);
  const handler = loadHandler({ fastMeta, legacySearch: legacy, process: { env: { YT_SEARCH_BUDGET: '6000', YT_SEARCH_TIMEOUT: '100' } } });

  const res = await run(handler, { query: { q: 'abc', date: 'today' } });
  assert.strictEqual(res.body.items.length, 10);
  assert.strictEqual(res.body.filterApplied, false);
  assert.match(res.body.filterNote, /絞り込みを外して再検索/);
  assert.strictEqual(res.body.source, 'innertube');
  assert.strictEqual(legacy.calls.length, 0);
});

test('YT_META 無効（従来経路のみ）のときは従来経路が動く', async () => {
  const fastMeta = makeFastMeta(() => null); // fastMeta は無効時に fallback を返す
  const legacy = makeLegacy([{ id: 'a' }, { id: 'b' }]);
  const handler = loadHandler({ fastMeta, legacySearch: legacy, YT_META_ENABLED: false, process: { env: {} } });

  const res = await run(handler, { query: { q: 'abc' } });
  assert.strictEqual(legacy.calls.length, 1, '無効でも従来経路を試す');
  assert.deepStrictEqual(res.body.items.map((i) => i.id), ['a', 'b']);
  assert.strictEqual(res.body.source, 'legacy');
});

test('0件でも 500 の HTML にせず JSON を返す（従来どおり）', async () => {
  const fastMeta = makeFastMeta(() => { throw new Error('boom'); });
  const handler = loadHandler({ fastMeta, legacySearch: makeLegacy([]), process: { env: {} } });
  const res = await run(handler, { query: { q: 'abc' } });
  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(res.body.items, []);
});

/* ------------------------------------------------- home.html の検索表示修正 */

function homeBlock() {
  const src = fs.readFileSync(HOME, 'utf8');
  const from = src.indexOf('async function loadContent');
  const to = src.indexOf('searchForm.onsubmit');
  assert.ok(from > 0 && to > from, 'loadContent ブロックが見つかる');
  return src.slice(from, to);
}

test('home.html: 別カテゴリで補うのはトレンド画面だけ（検索結果を混ぜない）', () => {
  const block = homeBlock();
  assert.match(block, /page === 0 && query === 'trending'/, '補填は trending 限定');
  assert.match(block, /currentQuery !== 'trending' && shorts\.length > 0/);
});

test('home.html: ショート追加ページは並列取得（逐次 await で固まらない）', () => {
  const block = homeBlock();
  assert.match(block, /Promise\.all\(\s*\[1, 2, 3\]\.map\(p => fetchEndpoint\(searchEndpoint\(currentQuery, p\)\)\)/, 'ページ1〜3を並列で取る');
  assert.doesNotMatch(block, /for \(let p = 1; p <= 3 && shorts\.length < needed; p\+\+\)/, '逐次ループは廃止');
});

test('home.html: ショート判定は type: short を優先（# だけを見ない）', () => {
  const src = fs.readFileSync(HOME, 'utf8');
  assert.match(src, /function isShortItem\(item\)/);
  assert.match(src, /if \(item\.type === 'short'\) return true;/);
  assert.match(src, /return String\(item\.title \|\| ''\)\.includes\('#'\);/, '# 既定も残す（ストリーム経路）');
  const block = homeBlock();
  assert.match(block, /if \(isShortItem\(item\)\) shorts\.push\(item\);/);
});
