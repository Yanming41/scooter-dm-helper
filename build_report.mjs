// build_report.mjs
//
// 通用的"识图+算旧新比例"批处理脚本——不是只给电动滑板车用的，任何品类都能跑，
// 用 --category=<id> 指定，具体品类的搜索关键词/提示词描述/配件过滤词全部在
// categories/<id>.json 里配置，这个脚本本身不认识"滑板车"这三个字。
//
// 【核心前提假设】：这整套流水线假设"卖家在标题/正文/评论区里自己标注的品牌型号信息是准确的"。
// 关键词提取(extract_hint.mjs)、Lens消歧(q参数)都是建立在这个假设上——如果卖家写错了型号
// (记错、笔误、故意含糊)，提取出来的hint会跟着错，后续判断也会被带偏，我们没有能力验证卖家
// 说的是不是真的。这是当前设计已知但没有处理的限制，跑出来的"型号识别"本质上是"卖家说的+
// 图片视觉匹配"的综合结果，不是独立于卖家陈述之外的客观验证。
//
// agent loop 设计：
//   1. 去重台账：report_<category>.json 里已经处理过的 note_id，只要这次的标题/价格/图片数量
//      跟上次记录的一样(见 computeFingerprint)，不管上次是成功还是失败，直接复用上次的结果，
//      不重新调用识图接口——帖子没变，重新识别大概率还是同一个结果，没必要浪费API额度。
//      只有内容真的变了(改价/换图/新帖子)才重新跑。之前处理过、但这次搜索结果里已经不在的
//      帖子(下架了)，结果照样保留在报告里，不会凭空消失。
//   2. 新的listing先过一遍 DeepSeek(纯文本)，判断标题+正文+评论区里有没有具体品牌型号信息：
//      - 有具体型号 → 当q参数传给Lens做消歧(实测能帮它从视觉相似的候选里锁定正确分支)
//      - 只有品类泛称(原文没有型号信息) → 不传q，让Lens纯视觉匹配——
//        传一个没有区分度的泛用词反而会把本来能做对的纯视觉排序搅乱(见#10案例)
//   3. 关键词(如果有) + 图片 一起丢给 identify_model.mjs 的 Lens+Gemini 混合流程
//   4. listing 之间并发处理(限流到同时最多几条)，不再是"一条等1.5秒再下一条"的串行等待——
//      listing与listing之间没有依赖关系，没理由排队等
//
// 货币规则：所有价格统一折算成加币(CAD)结算。listing的asking price本来就是加币；
// identify_model 现在自己标注每条零售价的币种，偶尔退化到美元来源时按实时汇率转一下。
//
// 用法: node build_report.mjs --category=escooter
//
// 待办(还没做，先记下来)：MediaCrawler自己的 config/base_config.py 里的 KEYWORDS 目前还是
// 手动同步 category.searchKeywords 过去的，没有自动化——每次换品类抓取前，记得把
// categories/<id>.json 里的 searchKeywords 手动抄一份到 MediaCrawler 的配置里。

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./load_env.mjs";
import { identifyModel } from "./identify_model.mjs";
import { extractHint } from "./extract_hint.mjs";
import { loadCategory, getCategoryIdFromArgs } from "./load_category.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 读consolidate_notes.mjs合并去重后的持久文件，不再硬编码某一天的日期——
// MediaCrawler每次重新抓都要先跑一遍 `node consolidate_notes.mjs` 更新这两份文件。
// 这两份是全品类共用的(小红书抓下来的原始数据不分品类)，只有 listings/report 是按品类分开的。
const XHS_CONTENTS_JSONL = path.join(__dirname, "all_contents.jsonl");
const XHS_COMMENTS_JSONL = path.join(__dirname, "all_comments.jsonl");

// 同时处理几条listing。实测：换成免费层级的Gemini key之后，并发3条(每条内部还要连续调好几次
// Gemini)直接触发429限流，大量请求静默失败——免费层RPM限制比付费层严格得多，降到1(不并发)。
const CONCURRENCY = 1;

// ---------- 工具函数 ----------

function extractNoteId(url) {
  const m = url.match(/explore\/([a-f0-9]+)/);
  return m ? m[1] : null;
}

// 判断"这条帖子跟上次处理时是不是同一个内容"——考虑过几种方案又都排除了：
//   - image_list的URL字符串：小红书图床URL每次抓都不一样(哪怕是同一批图片，签名会变)，
//     拿URL当指纹等于每次都判定"变了"，没法用。
//   - 小红书自己的 last_update_time 字段：MediaCrawler原样透传自小红书API(见
//     store/xhs/_store_impl.py)，看着像是现成的"内容是否变化"信号，但实测56条数据里
//     70%都跟发布时间不一样——这些是几个月前的旧闲置帖，不可能真被卖家频繁编辑，说明这个
//     字段的触发条件不只是"内容编辑"(可能任何互动/重新索引都会碰它)，小红书官方也没公开
//     文档说明，太不可靠，用它当指纹会导致几乎每次都误判成"变了"。
// 最终方案：价格文案+标题(这两个真改了就是改了) + 本地已归档图片的字节大小列表——
// 图片已经被 archive_images.mjs 下载到本地(images/<note_id>/<序号>.jpg)了，直接读文件大小，
// 免费拿到"图片内容有没有变"的强信号(换了一张不同的图，字节数几乎不可能刚好撞上)，
// 比单纯图片张数准，也不用真的做图片hash那么重。
function computeFingerprint(listing, record, noteId) {
  const imageCount = record?.image_list ? record.image_list.split(",").length : 0;
  const sizes = [];
  for (let i = 0; i < imageCount; i++) {
    try {
      sizes.push(statSync(path.join(__dirname, "images", noteId, `${i}.jpg`)).size);
    } catch {
      sizes.push("missing"); // 这张图还没归档到本地(比如URL 403没存到)，也算进指纹——
      // 等以后哪次archive成功补上了，指纹会变，自动触发重新识别。
    }
  }
  return `${listing.price ?? ""}|${listing.title ?? ""}|${sizes.join(",")}`;
}

function parseAskingPriceCAD(priceText) {
  const m = priceText.match(/(\d{2,5})/);
  return m ? Number(m[1]) : null;
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function toCAD(refs, fxRate) {
  return refs
    .map((r) => {
      if (r.currency === "CAD") return r.price;
      if (r.currency === "USD") return r.price * fxRate;
      return null;
    })
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function getUsdToCadRate() {
  const res = await fetch("https://api.frankfurter.app/latest?from=USD&to=CAD");
  const json = await res.json();
  return json.rates.CAD;
}

// 简单的并发限流worker pool：开 limit 个worker，每个worker从共享队列里不断取下一个任务，
// 不用装 p-limit 之类的依赖。
async function runWithConcurrency(items, limit, worker) {
  let idx = 0;
  async function runOne() {
    while (idx < items.length) {
      const current = idx++;
      await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
}

// ---------- 主流程 ----------

async function main() {
  const categoryId = getCategoryIdFromArgs();
  const category = await loadCategory(categoryId); // 没传categoryId这里会直接抛错，不猜默认品类
  console.log(`品类: ${category.displayName} (${category.id})`);

  const LISTINGS_FILE = path.join(__dirname, `listings_${category.id}.json`);
  const REPORT_JSON = path.join(__dirname, `report_${category.id}.json`);
  const REPORT_MD = path.join(__dirname, `report_${category.id}.md`);

  if (!existsSync(LISTINGS_FILE)) {
    console.error(`找不到 ${LISTINGS_FILE}——每个品类要有自己的 listings_<id>.json`);
    process.exit(1);
  }

  const env = await loadEnv();
  const { GEMINI_API_KEY: geminiApiKey, SERPAPI_API_KEY: serpApiKey, DEEPSEEK_API_KEY: deepseekApiKey } = env;
  for (const [name, val] of Object.entries({ GEMINI_API_KEY: geminiApiKey, SERPAPI_API_KEY: serpApiKey, DEEPSEEK_API_KEY: deepseekApiKey })) {
    if (!val) {
      console.error(`缺少 ${name}，去 .env 里配一下`);
      process.exit(1);
    }
  }

  console.log("拉取实时汇率 USD->CAD (给退化到美元来源的情况兜底)...");
  const fxRate = await getUsdToCadRate();
  console.log(`汇率: 1 USD = ${fxRate} CAD`);

  const listings = JSON.parse(await readFile(LISTINGS_FILE, "utf-8"));

  console.log("加载 MediaCrawler 原始数据(笔记正文+评论)...");
  const contentLines = (await readFile(XHS_CONTENTS_JSONL, "utf-8")).split("\n").filter(Boolean);
  const contentByNoteId = new Map();
  for (const line of contentLines) {
    const d = JSON.parse(line);
    contentByNoteId.set(d.note_id, d);
  }

  const commentsByNoteId = new Map();
  if (existsSync(XHS_COMMENTS_JSONL)) {
    const commentLines = (await readFile(XHS_COMMENTS_JSONL, "utf-8")).split("\n").filter(Boolean);
    for (const line of commentLines) {
      const c = JSON.parse(line);
      if (!commentsByNoteId.has(c.note_id)) commentsByNoteId.set(c.note_id, []);
      commentsByNoteId.get(c.note_id).push(c);
    }
    for (const [id, list] of commentsByNoteId) {
      list.sort((a, b) => Number(b.like_count || 0) - Number(a.like_count || 0));
      commentsByNoteId.set(id, list.slice(0, 5));
    }
  }

  // ---- 去重台账：帖子内容没变(价格/标题/图片数量都跟上次一样)就复用上次结果，不重新识别 ----
  const prevByNoteId = new Map();
  if (existsSync(REPORT_JSON)) {
    const prev = JSON.parse(await readFile(REPORT_JSON, "utf-8"));
    for (const r of prev.results) prevByNoteId.set(r.noteId, r);
  }

  let results = [];
  const pending = [];
  let reusedCount = 0;
  const currentNoteIds = new Set(listings.map((l) => extractNoteId(l.url)));
  for (const listing of listings) {
    const noteId = extractNoteId(listing.url);
    const record = contentByNoteId.get(noteId);
    const fingerprint = computeFingerprint(listing, record, noteId);
    const prevResult = prevByNoteId.get(noteId);
    if (prevResult && prevResult.contentFingerprint === fingerprint) {
      results.push(prevResult); // 内容没变，不管上次是成功还是失败，都直接复用，不重新调接口
      reusedCount++;
    } else {
      pending.push(listing); // 新帖子，或者内容变了(改价/换图/改标题)，需要重新识别
    }
  }
  // 之前处理过、但这次搜索结果里已经不在的帖子(下架了/没被搜到)，结果照样保留，不凭空丢掉——
  // 报告是"曾经见过的所有listing"的历史累积，不是"这次搜索结果"的快照。
  for (const [noteId, r] of prevByNoteId) {
    if (!currentNoteIds.has(noteId)) results.push(r);
  }

  console.log(`去重台账：${reusedCount} 条帖子内容没变化，复用上次结果；待(重新)处理 ${pending.length} 条，并发度 ${CONCURRENCY}`);

  async function processOne(listing) {
    const noteId = extractNoteId(listing.url);
    const askingPriceCAD = parseAskingPriceCAD(listing.price);
    const record = contentByNoteId.get(noteId);
    const imageUrls = record?.image_list ? record.image_list.split(",") : [];

    const contentFingerprint = computeFingerprint(listing, record, noteId);

    if (imageUrls.length === 0) {
      console.log(`[${listing.title.slice(0, 20)}] 没有图片数据，跳过识图`);
      results.push({ ...listing, noteId, askingPriceCAD, contentFingerprint, identifyFound: false, identifyReason: "无图片数据" });
      await writeReport(results, fxRate, REPORT_JSON, REPORT_MD, category);
      return;
    }

    // 第一步：LLM从标题+正文+评论判断有没有具体型号信息。
    // 只有原文里真的有具体品牌型号时，才把它当q传给Lens做消歧；
    // 原文只有泛称(没有型号信息)时，不传q，让Lens纯视觉匹配——
    // 传一个没有区分度的泛用词只会搅乱本来能做对的纯视觉排序(见#10案例)。
    let hint;
    try {
      const extracted = await extractHint(
        { title: record.title, desc: record.desc, comments: commentsByNoteId.get(noteId) ?? [] },
        deepseekApiKey,
        category
      );
      if (extracted.hasSpecificModel) {
        hint = extracted.hint;
        console.log(`[${listing.title.slice(0, 20)}] 提取到具体型号，作为hint: ${hint}`);
      } else {
        console.log(`[${listing.title.slice(0, 20)}] 原文没有型号信息(只有"${extracted.hint}")，不传hint，纯视觉匹配`);
      }
    } catch (e) {
      console.error(`[${listing.title.slice(0, 20)}] 关键词提取失败，不传hint: ${e.message}`);
    }

    let identify;
    try {
      identify = await Promise.race([
        identifyModel(imageUrls, { category, geminiApiKey, serpApiKey, hint, title: record.title, noteId }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("外层硬超时(5分钟)，放弃这一条")), 5 * 60 * 1000)
        ),
      ]);
    } catch (e) {
      console.error(`[${listing.title.slice(0, 20)}] 识图出错: ${e.message}`);
      identify = { found: false, modelGuess: null, retailPriceRefs: [], reason: `出错: ${e.message}` };
    }

    let retailPriceCAD = null;
    let usedNewRatio = null;
    if (identify.retailPriceRefs?.length > 0) {
      const cadPrices = toCAD(identify.retailPriceRefs, fxRate);
      if (cadPrices.length > 0) {
        retailPriceCAD = Math.round(median(cadPrices) * 100) / 100;
        if (askingPriceCAD !== null) {
          usedNewRatio = Math.round((askingPriceCAD / retailPriceCAD) * 1000) / 1000;
        }
      }
    }

    console.log(
      `[${listing.title.slice(0, 20)}] 型号: ${identify.modelGuess ?? "未找到"} | asking: ${
        askingPriceCAD ?? "议价"
      } CAD | 一手参考: ${retailPriceCAD ?? "无"} CAD | 旧新比例: ${
        usedNewRatio !== null ? (usedNewRatio * 100).toFixed(1) + "%" : "无法计算"
      }`
    );

    results.push({
      ...listing,
      noteId,
      askingPriceCAD,
      contentFingerprint,
      hint,
      modelGuess: identify.modelGuess,
      visibleText: identify.visibleText,
      retailPriceRefs: identify.retailPriceRefs,
      retailPriceCAD,
      usedNewRatio,
      triedImageUrl: identify.triedImageUrl,
      identifyFound: identify.found,
      identifyReason: identify.reason,
    });

    // 每条完成就落盘一次；并发情况下写文件可能交叉，但每次写的都是当时的完整快照，
    // 最坏情况丢一次中间快照，最终结果不会错。
    await writeReport(results, fxRate, REPORT_JSON, REPORT_MD, category);
  }

  await runWithConcurrency(pending, CONCURRENCY, processOne);

  console.log(`\n全部完成，结果写到:\n  ${REPORT_JSON}\n  ${REPORT_MD}`);
}

async function writeReport(results, fxRate, reportJsonPath, reportMdPath, category) {
  await writeFile(
    reportJsonPath,
    JSON.stringify({ category: category.id, fxRate, generatedAt: new Date().toISOString(), results }, null, 2),
    "utf-8"
  );

  const mdLines = [
    `# ${category.displayName} 旧新比例报告`,
    ``,
    `生成时间: ${new Date().toISOString()}　|　汇率(仅用于美元来源兜底): 1 USD = ${fxRate} CAD`,
    ``,
    `| 标题 | Asking(CAD) | 型号识别 | 一手参考(CAD) | 旧新比例 |`,
    `|---|---|---|---|---|`,
    ...results.map(
      (r) =>
        `| ${r.title.slice(0, 25)} | ${r.askingPriceCAD ?? "议价"} | ${
          r.modelGuess ?? "未识别"
        } | ${r.retailPriceCAD ?? "-"} | ${
          r.usedNewRatio !== null ? (r.usedNewRatio * 100).toFixed(1) + "%" : "-"
        } |`
    ),
  ];
  await writeFile(reportMdPath, mdLines.join("\n"), "utf-8");
}

main().catch((e) => {
  console.error("脚本出错:", e);
  process.exit(1);
});
