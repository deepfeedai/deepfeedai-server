/**
 * Deep Feed AI Admin — GET /api/trends
 * Analyzes recent articles to surface trending keywords, companies,
 * category breakdown, and 7-day history sparklines.
 * Public endpoint — no auth required.
 *
 * Query params:
 *   force=true — bust the 2h Postgres cache
 *
 * Cache: Postgres trends_cache table, 2h TTL.
 * History: Postgres trends_history table, daily snapshots for sparklines.
 *
 * AI provider required for company extraction (configured via ai-router).
 */
const express          = require('express');
const router           = express.Router();
const { getPool }      = require('../db');
const { toSlug, serializeRow, asyncHandler } = require('../lib/utils');
const { complete: aiComplete } = require('../lib/ai-router');
const { getCategories } = require('../lib/categories');

const CACHE_TTL_HOURS = 2;

// ── Keyword extraction ────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','as','is','was','are','be','been','have','has','do','does','did',
  'will','would','could','should','may','might','can','new','ai','news',
  'latest','today','this','that','it','its','not','now','how','why','who',
  'what','when','which','all','more','one','two','three','over','after',
  'says','just','also','than','into','about','up','out','their','they',
  'them','use','used','using','get','gets','got','make','made','making',
  'take','takes','took','first','last','want','wants','show','shows',
  'year','years','week','weeks','day','days','time','times','way','ways',
  'work','works','our','your','his','her','my','we','you','he','she',
  'being','had','where','while','amid','between','around','within',
  'without','through','during','before','since','against','among','able',
  'every','both','still','even','here','there','back','off','down','right',
  'left','help','like','need','set','plan','call','calls','called','move',
  'said','report','reports','look','looks','share','come','comes','coming',
  'give','gives','given','keep','kept','next','then','been','tech','these',
  'those','very','much','many','well','says','into','only','some','such',
  'each','most','other','than','same','long','high','open','used','turn',
  'part','show','put','see','him','its','own','let','under','again',
]);

function extractKeywords(articles) {
  const kwMap = {};
  for (const article of articles) {
    const words = (article.title || '').split(/\W+/).filter(w => w.length > 3 && !/^\d+$/.test(w));
    for (const word of words) {
      const lower = word.toLowerCase();
      if (STOP_WORDS.has(lower)) continue;
      if (!kwMap[lower]) kwMap[lower] = { word, count: 0 };
      kwMap[lower].count++;
    }
  }
  return Object.values(kwMap)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

// ── Company extraction (parallel batched Gemini) ──────────────────────────────

async function extractCompaniesParallel(articles, tenantId, categoryNames) {
  const BATCH = 5;
  const batches = [];
  for (let i = 0; i < Math.min(articles.length, 40); i += BATCH) {
    batches.push(articles.slice(i, i + BATCH));
  }

  const topicCtx = categoryNames && categoryNames.length
    ? categoryNames.join(', ')
    : 'news';

  const { loadPrompt } = require('../lib/prompt-loader');

  const batchResults = await Promise.all(batches.map(async (batch) => {
    const texts = batch
      .map((a, i) => `${i + 1}. ${a.title}. ${(a.summary || '').slice(0, 200)}`)
      .join('\n');

    const p = loadPrompt('entity-extract');
    const { messages, ...meta } = p.render({ topicCtx, texts });

    try {
      const result = await aiComplete({
        ...meta, messages, tenantId,
        trigger: 'page-load',
      });

      if (!result) return []; // budget denied
      const out = (result.text || '').trim();
      if (!out || out.toUpperCase() === 'NONE') return [];
      return out.split(',').map(c => c.trim()).filter(c => c.length > 1 && c.length < 60);
    } catch (e) {
      console.warn('[trends] AI batch error:', e.message);
      return [];
    }
  }));

  const map = {};
  for (const names of batchResults) {
    for (const name of names) map[name] = (map[name] || 0) + 1;
  }
  return map;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcCategories(articles) {
  const counts = {};
  for (const a of articles) {
    const cat = a.category || 'Industry';
    counts[cat] = (counts[cat] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count }));
}

function findHotArticle(articles, topKeywords) {
  const kwSet = new Set(topKeywords.slice(0, 6).map(k => k.word.toLowerCase()));
  let best = null, bestScore = 0;
  for (const a of articles) {
    const words = (a.title || '').toLowerCase().split(/\W+/);
    const score = words.filter(w => kwSet.has(w)).length;
    if (score > bestScore) { best = a; bestScore = score; }
  }
  if (!best) return null;
  return {
    title:    best.title,
    url:      best.source_url,
    source:   best.source,
    category: best.category,
    image:    best.image_url,
    slug:     best.slug || toSlug(best.title),
    score:    bestScore,
  };
}

function calcRising(current, history) {
  if (!history || history.length === 0) return new Set();
  const prev = history[0];
  const prevMap = {};
  for (const k of (prev.trending  || [])) prevMap[k.word.toLowerCase()] = k.count;
  for (const c of (prev.companies || [])) prevMap[c.name.toLowerCase()] = c.count;

  const rising = new Set();
  for (const k of current.trending) {
    const p = prevMap[k.word.toLowerCase()] || 0;
    if (k.count > p * 1.2 || (p === 0 && k.count >= 2)) rising.add(k.word.toLowerCase());
  }
  for (const c of current.companies) {
    const p = prevMap[c.name.toLowerCase()] || 0;
    if (c.count > p * 1.2 || (p === 0 && c.count >= 2)) rising.add(c.name.toLowerCase());
  }
  return rising;
}

function buildSparkline(label, isCompany, history) {
  const key = label.toLowerCase();
  return history.slice(0, 7).reverse().map(snap => {
    const items = isCompany ? (snap.companies || []) : (snap.trending || []);
    const hit = isCompany
      ? items.find(c => c.name.toLowerCase() === key)
      : items.find(k => k.word.toLowerCase() === key);
    return hit ? hit.count : 0;
  });
}

// ── Postgres cache helpers ────────────────────────────────────────────────────

async function getCachedResult(tenantId) {
  const result = await getPool().query(
    `SELECT payload FROM trends_cache
     WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '2 hours'
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId]
  );
  return result.rows[0]?.payload || null;
}

async function setCachedResult(payload, tenantId) {
  await getPool().query(
    `INSERT INTO trends_cache (tenant_id, payload, created_at) VALUES ($1, $2, NOW())`,
    [tenantId, payload]
  );
  // Keep only the last 48 rows (2h cache * 24 = 48 possible entries per day max)
  await getPool().query(
    `DELETE FROM trends_cache
     WHERE tenant_id = $1 AND id NOT IN (SELECT id FROM trends_cache WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 48)`,
    [tenantId]
  );
}

async function getHistory(tenantId) {
  const result = await getPool().query(
    `SELECT payload FROM trends_history
     WHERE tenant_id = $1 AND snapshot_date >= CURRENT_DATE - INTERVAL '7 days'
     ORDER BY snapshot_date DESC`,
    [tenantId]
  );
  return result.rows.map(r => r.payload);
}

async function saveSnapshot(snapshot, tenantId) {
  await getPool().query(
    `INSERT INTO trends_history (tenant_id, snapshot_date, payload, created_at)
     VALUES ($1, CURRENT_DATE, $2, NOW())
     ON CONFLICT (tenant_id, snapshot_date) DO UPDATE SET payload = $2, created_at = NOW()`,
    [tenantId, snapshot]
  );
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get('/', asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';

  // Serve from cache unless force-busted
  const tenantId = req.tenantId;
  if (!force) {
    const cached = await getCachedResult(tenantId);
    if (cached) {
      res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=7200');
      return res.status(200).json(cached);
    }
  }

  // Fetch articles directly from database
  const dbResult = await getPool().query(
    `SELECT * FROM articles
     WHERE tenant_id = $1 AND is_published = 1 AND (is_archived = 0 OR is_archived IS NULL)
     ORDER BY published_at DESC`,
    [tenantId]
  );
  const articles = dbResult.rows.map(serializeRow);

  if (articles.length === 0) {
    return res.status(404).json({ error: 'No articles to analyze.' });
  }

  // Analysis
  const cats = await getCategories(tenantId);
  const categoryNames = cats.map(c => c.name);

  const [keywords, companyMap] = await Promise.all([
    Promise.resolve(extractKeywords(articles)),
    extractCompaniesParallel(articles, tenantId, categoryNames),
  ]);

  const topCompanies = Object.entries(companyMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, count]) => ({ name, count }));

  const categories = calcCategories(articles);
  const hotArticle = findHotArticle(articles, keywords);

  // Load historical snapshots from Postgres
  const history  = await getHistory(tenantId);
  const risingSet = calcRising({ trending: keywords, companies: topCompanies }, history);

  const enrichedKeywords = keywords.map(k => ({
    ...k,
    rising:    risingSet.has(k.word.toLowerCase()),
    sparkline: buildSparkline(k.word, false, history),
  }));

  const enrichedCompanies = topCompanies.map(c => ({
    ...c,
    rising:    risingSet.has(c.name.toLowerCase()),
    sparkline: buildSparkline(c.name, true, history),
  }));

  const result = {
    trending:     enrichedKeywords,
    companies:    enrichedCompanies,
    categories,
    hotArticle,
    articleCount: articles.length,
    timestamp:    new Date().toISOString(),
  };

  // Cache result and save daily snapshot
  await Promise.all([
    setCachedResult(result, tenantId),
    saveSnapshot({ trending: keywords, companies: topCompanies, timestamp: result.timestamp }, tenantId),
  ]);

  res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=7200');
  return res.status(200).json(result);
}));

module.exports = router;
