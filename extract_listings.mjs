// extract_listings.mjs
//
// 补上流水线里缺的一环：all_contents.jsonl(全品类共用、MediaCrawler原始抓取结果，没有price/
// location字段，也没有过滤"这条真的是在卖目标品类东西吗") -> listings_<id>.json(build_report.mjs
// 真正读的输入，需要{date, title, price, location, url}这种干净结构，且只包含真的在卖这个品类
// 商品的帖子)。
//
// 这一步之前是靠人工/一次性脚本做的，早期生成的 listings_escooter.json 从没被自动化流水线
// 更新过——后来 crawl.mjs/ingest.mjs 把抓取+合并+存图都串起来了，但都是往 all_contents.jsonl
// 里加数据，没人把新数据同步搬进 listings_<id>.json，导致新抓到的笔记进不了识图报告，
// 这个bug是2026-08-17发现的。这个脚本补上这一步，而且做成流水线的一部分(接进ingest.mjs)，
// 不再是一次性的。
//
// 为什么价格提取要用DeepSeek、不能用正则：早期确实吃过纯正则的亏(见project笔记)——
// 价格写法五花八门("$200"/"200刀"/"200"/"议价"/"可小刀"/"原价xxx现价xxx")，正则要么漏、
// 要么错，干脆丢给LLM去读原文判断，跟 extract_hint.mjs 是同一个思路。
//
// 顺带做"这条帖子是不是真的在卖目标品类"的相关性过滤——搜索关键词命中不代表内容真的相关
// (比如标题里恰好带了"scooter"这个词，但其实是在讨论别的事)，不相关的直接排除，不进
// listings_<id>.json。
//
// 用法: node extract_listings.mjs --category=<id>

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./load_env.mjs";
import { loadCategory, getCategoryIdFromArgs } from "./load_category.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENTS_FILE = path.join(__dirname, "all_contents.jsonl");
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const CONCURRENCY = 5; // 纯文本任务，比identify_model那种要调Gemini/Lens的快得多，并发度可以高一些

function extractNoteId(record) {
  return record.note_id;
}

function buildPrompt(title, desc, category) {
  return `这是一条小红书上搜出来的帖子，标题："${title}"，正文："${desc || "(无正文)"}"。

判断:
1. 这条帖子是不是真的在卖二手的"${category.displayName}(${category.aliasesForPrompt})"——
   搜索关键词命中不代表内容真的相关，帖子可能是讨论/求购/完全无关的内容，这种要排除。
2. 如果是在卖，从原文里提取卖家标注的价格文案——原样保留卖家的写法(比如"$200"/"200刀"/"议价"/
   "可小刀"/"原价xxx现价xxx"这种)，不要自己换算或改写；原文完全没提价格就写"未注明"。
3. 如果是在卖，提取原文里提到的交易地点/城市/区域，原文没提就写"未注明"。

只输出一个json代码块，不要任何其他文字：

\`\`\`json
{"isRelevant": true, "price": "价格原文写法或未注明", "location": "地点原文写法或未注明"}
\`\`\``;
}

function extractJsonBlock(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * @param {object} category 必传，见 load_category.mjs
 * @returns {Promise<{isRelevant: boolean, price: string, location: string}>}
 */
export async function extractListingInfo(title, desc, deepseekApiKey, category) {
  if (!category) throw new Error("没有传 category——不猜默认品类");
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${deepseekApiKey}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: buildPrompt(title, desc, category) }],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`DeepSeek提取失败: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  const text = json.choices[0].message.content.trim();
  const parsed = extractJsonBlock(text);
  if (!parsed) throw new Error(`没能解析DeepSeek输出: ${text.slice(0, 200)}`);
  return parsed;
}

function formatDate(ms) {
  if (!Number.isFinite(ms)) return "未知日期";
  return new Date(ms).toISOString().slice(0, 10);
}

async function runWithConcurrency(items, limit, worker) {
  let idx = 0;
  async function runOne() {
    while (idx < items.length) {
      const current = idx++;
      await worker(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
}

async function main() {
  const categoryId = getCategoryIdFromArgs();
  const category = await loadCategory(categoryId);
  console.log(`品类: ${category.displayName} (${category.id})`);

  if (!existsSync(CONTENTS_FILE)) {
    console.error(`找不到 ${CONTENTS_FILE}，先跑 node consolidate_notes.mjs`);
    process.exit(1);
  }
  const env = await loadEnv();
  if (!env.DEEPSEEK_API_KEY) {
    console.error("缺少 DEEPSEEK_API_KEY，去 .env 里配一下");
    process.exit(1);
  }

  const CACHE_FILE = path.join(__dirname, `.listings_cache_${category.id}.json`);
  const OUTPUT_FILE = path.join(__dirname, `listings_${category.id}.json`);

  // 缓存已经判断过的note_id(不管相关还是不相关)，避免每次都重新问一遍LLM——
  // 跟build_report.mjs的去重台账是同一个思路，只是这里判断"变没变"更简单粗暴：note_id处理过就跳过，
  // 不做内容指纹比对(帖子标题/正文基本不会变，这一步不涉及图片，成本也低得多，没必要做那么精细)。
  let cache = {};
  if (existsSync(CACHE_FILE)) cache = JSON.parse(await readFile(CACHE_FILE, "utf-8"));

  const lines = (await readFile(CONTENTS_FILE, "utf-8")).split("\n").filter(Boolean);
  const records = lines.map((l) => JSON.parse(l));
  const pending = records.filter((r) => !cache[extractNoteId(r)]);
  console.log(`共 ${records.length} 条原始笔记，${records.length - pending.length} 条已处理过，待处理 ${pending.length} 条`);

  let done = 0;
  await runWithConcurrency(pending, CONCURRENCY, async (record) => {
    const noteId = extractNoteId(record);
    try {
      const result = await extractListingInfo(record.title, record.desc, env.DEEPSEEK_API_KEY, category);
      cache[noteId] = {
        isRelevant: result.isRelevant,
        price: result.price || "未注明",
        location: result.location || "未注明",
        title: record.title,
        date: formatDate(record.time),
        url: record.note_url,
      };
    } catch (e) {
      console.error(`[${record.title.slice(0, 20)}] 提取失败，跳过这条: ${e.message}`);
      // 不写入cache——不是"判断为不相关"，是"这次没判断成功"，下次重跑还会再试一次，
      // 不能跟真的判断过的记录混在一起。
    }
    done++;
    if (done % 10 === 0) console.log(`进度: ${done}/${pending.length}`);
  });

  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");

  const listings = Object.values(cache)
    .filter((r) => r.isRelevant)
    .map(({ date, title, price, location, url }) => ({ date, title, price, location, url }))
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // 新的在前

  await writeFile(OUTPUT_FILE, JSON.stringify(listings, null, 2), "utf-8");
  console.log(`\n完成：${Object.keys(cache).length} 条已判断，其中 ${listings.length} 条相关，写到 ${OUTPUT_FILE}`);
}

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  main().catch((e) => {
    console.error("脚本出错:", e);
    process.exit(1);
  });
}
