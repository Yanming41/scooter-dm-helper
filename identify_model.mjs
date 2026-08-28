// identify_model.mjs
//
// 通用识图模块——不只给电动滑板车用，任何品类的二手商品都能用，靠调用方传进来的
// `category`(见 load_category.mjs / categories/*.json)决定"具体在找什么"，代码本身
// 不认识"滑板车"这三个字。
//
// 混合架构：
//   0. Gemini 预处理(一次调用，把listing的全部图片一起传进去) —— 判断这个帖子实际在卖几件
//      东西、哪些图片是"目标品类"相关的(整件商品/包装/铭牌都算，排除掉多物混卖帖里其它不相关的
//      商品图)，并按信息量排优先级。取代了"就按原始顺序试前3张"这种盲选——之前吃过亏：多物
//      混卖的帖子(比如滑板车+闲置IKEA家具一起卖)，正好试到了别的商品图上。
//   1. SerpApi Google Lens —— 真·以图搜图(视觉相似度匹配，跟你手动上传图片到Google搜索
//      是同一个后端 lens.google.com/uploadbyurl)，负责"这张图长得像什么"，准确度最高。
//      SerpApi免费额度用完(250次/月很容易撞满)会自动降级到浏览器扩展查询这条免费路径
//      (见 getCandidates 函数 + docs/lens_extension_bridge_api.md)，两条路径最终都统一成
//      同一种candidates格式，后面Gemini验证那步不用关心走的是哪条。
//   2. Gemini(仅视觉+推理，不用google_search grounding) —— 负责两件事：
//      a. 读图片上的可见文字(包装/铭牌/网页截图里的标题价格参数)
//      b. 从Lens给的候选匹配列表里，结合图片本身和读到的文字，挑出真正对应"这件商品"的条目，
//         排除配件和明显不相关的商品
//
// 为什么不再用 Gemini+google_search 单独闭环(更早的一版)：
//   实测 Gemini 自己"看图形成印象→拿印象去搜索"这个机制，本质是"看图猜测+文字搜索"，
//   不是真正的视觉匹配，容易在长得像的型号之间认错(比如G2 Max认成E2 Pro)，
//   而且带grounding的调用很慢(经常60-90秒一次)。现在Lens负责视觉匹配、Gemini只做OCR+筛选判断，
//   不用grounding工具，快很多，也更准。
//
// 用法（作为模块）：
//   import { identifyModel } from "./identify_model.mjs";
//   import { loadCategory } from "./load_category.mjs";
//   const category = await loadCategory("escooter");
//   const result = await identifyModel(imageUrls, { category, ... });
//
// 用法（命令行直接测试）：
//   node identify_model.mjs <note_id> --category=escooter

import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { startBridge } from "./lens_extension_bridge.mjs";
import { lensSearchViaExtension } from "./lens_extension_search.mjs";

const __dirname_top = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_ROOT = path.join(__dirname_top, "images");

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODEL = "gemini-flash-lite-latest"; // 2.5-flash对新账号返回404(不再对新用户开放)，
// 2.5-pro/3.6-flash批处理场景下都撞过配额限制，flash-lite是目前唯一confirm能跑通的

const DOWNLOAD_TIMEOUT_MS = 30_000;
const GEMINI_TIMEOUT_MS = 60_000; // 不带grounding了，应该比上一版快很多，但还是设个上限保险

// 图片URL是有时效的，之前吃过好几次亏(隔一天就403)。这里做本地归档优先：
// 传了cacheKey(格式 "<note_id>/<图片序号>"，跟archive_images.mjs用的是同一套路径规则)的话，
// 先查本地 images/<cacheKey>.jpg 有没有，有就直接读，不碰网络；没有才去下载，
// 下载成功顺便存一份到本地——这样跑过一次的图，以后再也不用担心CDN链接过期。
async function downloadImage(url, cacheKey) {
  if (cacheKey) {
    const localPath = path.join(IMAGES_ROOT, `${cacheKey}.jpg`);
    if (existsSync(localPath)) {
      return fsReadFile(localPath);
    }
  }

  const res = await fetch(url, {
    headers: { Referer: "https://www.xiaohongshu.com/" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`图片下载失败: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  if (cacheKey) {
    const localPath = path.join(IMAGES_ROOT, `${cacheKey}.jpg`);
    await fsMkdir(path.dirname(localPath), { recursive: true });
    await fsWriteFile(localPath, buf).catch(() => {}); // 存本地失败不影响主流程，忽略
  }
  return buf;
}

// ---------- 第0步：Gemini 预处理，一次看完全部图片，判断哪些跟目标品类相关+按信息量排序 ----------

const MAX_IMAGES_TO_ANALYZE = 10; // 一次传太多张图片会导致token/费用失控，封顶10张

function buildImageTriagePrompt(title, imageCount, category) {
  return `这是小红书上一条二手物品listing，标题是："${title}"，一共有${imageCount}张图片(按原始顺序编号0~${imageCount - 1})。

这条帖子有可能只卖一件东西，也有可能是"顺便清一批闲置"的多物品混卖帖(比如目标商品+别的闲置家具/电器一起发)。

请完成：
1. 判断这条帖子实际在卖几件不同的物品(itemCount)。
2. 判断每一张图片跟"${category.displayName}(${category.aliasesForPrompt})"是不是相关——实物拍照、包装、铭牌、
   商品详情页截图都算相关；如果是同一帖里其它不相关的商品(别的品类)，不算相关。
3. 把"相关"的图片按**适不适合拿去做以图搜图**排序，优先级从高到低：
   a. **完整展示商品本体、拍摄清晰、没有遮挡、构图完整的图排最前面**——这类图片视觉特征最完整，
      拿去做反向图片搜索(Google Lens)最容易匹配到网上的同款商品，是首选。
   b. 其次是能清楚看到品牌/型号文字的包装/铭牌/详情页截图——这类图文字信息量大，但如果商品本体
      被裁切/遮挡，视觉搜索效果不如(a)。
   c. 模糊、局部特写、远景/场景照(商品只占画面一小部分)排在最后。

最后**必须**单独用一个 \`\`\`json 代码块给出结果：

\`\`\`json
{
  "itemCount": 1,
  "relevantImageIndexes": [2, 0, 4]
}
\`\`\`

如果一张相关的图都没有，relevantImageIndexes给空数组。`;
}

/**
 * 一次性把listing的全部图片(封顶10张)传给Gemini，判断哪些跟目标品类相关、按信息量排序。
 * 顺带把这一步已经下载过的图片buffer缓存下来传出去，后面主流程用同一张图就不用重新下载了。
 * @returns {Promise<{orderedUrls: string[], bufferCache: Map<string, Buffer>}>}
 */
async function selectRelevantImages(imageUrls, title, geminiApiKey, noteId, category) {
  const capped = imageUrls.slice(0, MAX_IMAGES_TO_ANALYZE);

  const downloads = await Promise.all(
    capped.map((url, i) =>
      downloadImage(url, noteId ? `${noteId}/${i}` : undefined).catch(() => null)
    )
  );
  const pairs = capped.map((url, i) => ({ url, buf: downloads[i] })).filter((p) => p.buf);
  const bufferCache = new Map(pairs.map((p) => [p.url, p.buf]));
  if (pairs.length === 0) return { orderedUrls: imageUrls, bufferCache }; // 全部下载失败，退化成原始顺序

  let res;
  try {
    res = await fetchWithRetry(
      GEMINI_URL,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": geminiApiKey,
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({
          model: MODEL,
          input: [
            { type: "text", text: buildImageTriagePrompt(title, pairs.length, category) },
            ...pairs.map((p) => ({
              type: "image",
              data: p.buf.toString("base64"),
              mime_type: "image/jpeg",
            })),
          ],
        }),
      },
      GEMINI_TIMEOUT_MS
    );
  } catch {
    return { orderedUrls: imageUrls, bufferCache }; // 预处理本身出错(比如限流)，退化成原始顺序，不影响主流程往下走
  }

  if (!res.ok) return { orderedUrls: imageUrls, bufferCache };
  const json = await res.json();
  const modelOutput = json.steps?.find((s) => s.type === "model_output");
  const textItem = modelOutput?.content?.find((c) => c.type === "text");
  const parsed = textItem ? extractJsonBlock(textItem.text) : null;

  console.error(`[选图预处理] 一共${pairs.length}张图可分析，Gemini判断: itemCount=${parsed?.itemCount}，relevantImageIndexes=${JSON.stringify(parsed?.relevantImageIndexes)}`);

  const indexes = parsed?.relevantImageIndexes;
  if (!Array.isArray(indexes) || indexes.length === 0) {
    console.error(`[选图预处理] 没有可用结果，退化成原始顺序`);
    return { orderedUrls: imageUrls, bufferCache };
  }

  const ordered = indexes.map((i) => pairs[i]?.url).filter(Boolean);
  console.error(`[选图预处理] 最终选中并排序的图: ${JSON.stringify(ordered)}`);
  return { orderedUrls: ordered.length ? ordered : imageUrls, bufferCache };
}

// ---------- 第一步：SerpApi Google Lens 视觉匹配 ----------

async function lensSearch(imageUrl, serpApiKey, hint) {
  const params = new URLSearchParams({
    api_key: serpApiKey,
    engine: "google_lens",
    url: imageUrl,
    type: "all",
    country: "ca", // 偏向加拿大零售源，天然CAD报价，减少美元来源需要换算的情况
    hl: "en",
  });
  // q: 配合图片一起传的文字提示，帮Lens在长得像的型号之间消歧(比如G2 Max vs E2 Pro)。
  // 只有原文里真有具体型号信息时才应该传这个(由 extract_hint.mjs 判断)，泛称不要传。
  if (hint) params.set("q", hint);

  const res = await fetch(`https://serpapi.com/search?${params}`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  const json = await res.json();
  if (json.search_metadata?.status !== "Success") {
    throw new Error(`SerpApi返回非Success状态: ${json.search_metadata?.status}`);
  }
  return json.visual_matches ?? [];
}

function inferCurrency(link) {
  return /\.ca(\/|$)/i.test(link ?? "") ? "CAD" : "USD";
}

// 取Lens排名前N条交给Gemini判断——之前这里按"有没有价格"过滤，结果实测把排名第1/2名
// (Lens自己判断视觉最相似，但没带inline价格)的正确候选直接筛掉了，Gemini只能矮子里挑将军，
// 从排名靠后但恰好带价格标签的候选里选(比如"ES1L"排第1名没价格被筛掉，"C20儿童款"排第16名
// 带价格进了候选池，Gemini就认成了C20)。现在不看有没有价格，按Lens原始排名取前N条：
// 没价格的候选依然能帮Gemini认出正确型号(modelGuess)，价格由后面的兜底搜索(serpApiPriceSearch)补。
function prefilterMatches(matches) {
  return matches.slice(0, 15).map((m, i) => ({
    index: i,
    title: m.title,
    source: m.source,
    price: m.price?.value ?? null, // 没有就是null，不强求
    link: m.link,
  }));
}

// 免费额度用完时(SerpApi 250次/月很容易撞满)自动降级到浏览器扩展查询(见
// chrome_lens_extension/ + lens_extension_bridge.mjs + lens_extension_search.mjs)——
// 免费、无限量，代价是要求你的真实Chrome开着、装了那个扩展，慢一些(要真的开个标签页)。
// 两条路径统一转换成同一种candidates格式，后面Gemini验证那步不用关心走的是哪条路。
let bridgeStarted = false;
async function getCandidates(url, serpApiKey, hint, buf, localImagePath) {
  if (serpApiKey) {
    try {
      const matches = await lensSearch(url, serpApiKey, hint);
      return prefilterMatches(matches);
    } catch (e) {
      console.error(`[Lens] SerpApi失败(${e.message})，降级到浏览器扩展...`);
    }
  }

  if (!bridgeStarted) {
    await startBridge();
    bridgeStarted = true;
  }
  // 扩展要的是本地文件路径，不是URL——优先用已经归档好的本地缓存路径；
  // 没有的话(比如CLI单独测试、没传noteId)就把已经下载好的buf临时写一份到系统temp目录。
  let imagePath = localImagePath;
  if (!imagePath) {
    imagePath = path.join(tmpdir(), `lens_${randomUUID()}.jpg`);
    await fsWriteFile(imagePath, buf);
  }
  return lensSearchViaExtension(imagePath);
}

// ---------- 第二步：Gemini 读图片文字 + 从候选列表里挑出真正匹配目标商品的条目 ----------

function buildValidationPrompt(candidates, category) {
  return `这是一张二手${category.displayName}listing里的图片。请完成：

1. 逐字读出图片上所有可见的文字（商品标题、品牌名、型号编号、价格、配置参数、包装/铭牌信息等），不要省略。

2. 下面是通过 Google 反向图片搜索(Google Lens)找到的候选商品列表，**按视觉相似度从高到低排序**(index=0是Lens认为最相似的)，里面**可能混有配件或者跟这件商品完全不相关的商品**，不是每一条都对。有些候选的price字段是null——这只是Lens没给这条配报价，不代表它不是正确匹配，排名靠前的候选依然要认真考虑：

${JSON.stringify(candidates, null, 2)}

3. 结合图片本身、你读到的文字、以及候选列表的排序，判断：
   - 这件${category.displayName}具体是什么品牌+型号？(优先参考排名靠前的候选，但如果图片本身明显跟排名靠前的候选对不上，可以采信排名靠后但更吻合的)
   - 上面候选列表里，哪些条目(按index)是真正对应"这件商品本身"的匹配？排除配件和不相关商品。带price的和不带price的都可以选，只要是型号匹配的整件商品。

**什么时候不要硬猜品牌**：如果同时满足——(a) 商品本身没有可读的品牌/型号标记(铭牌、包装、车身logo都没拍到或看不清)，(b) 候选列表里排名靠前的几条彼此指向明显不同的品牌、没有形成一致意见——这种情况说明这张图的证据本身就是混乱、不足以确认品牌的，**不要**矮子里拔将军从候选里随便选一个当答案。这时把 modelGuess 设为 null，把 brandUnclear 设为 true。反过来，只要商品本身有清楚的品牌标记，或者候选列表里排名靠前的条目明显都指向同一个品牌，就正常给出 modelGuess，不用因为候选里混了几条无关的也设 brandUnclear。

最后**必须**单独用一个 \`\`\`json 代码块给出结构化结果：

\`\`\`json
{
  "visibleText": "逐字抄录的可见文字，没有则null",
  "modelGuess": "具体品牌+型号，没有则null",
  "brandUnclear": false,
  "validIndexes": [0, 2]
}
\`\`\``;
}

// 把attempts里的真实报错(HTTP状态码等)摘出来拼进reason，方便事后从report.json里
// 直接看出是"限流/网络出错"还是"确实没找到匹配"，不用再手动复现一遍。
function summarizeErrors(attempts) {
  const errors = attempts.map((a) => a.error).filter(Boolean);
  return errors.length ? `(报错详情: ${errors.join(" | ")})` : "";
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

// 免费层Gemini实测有个滚动配额(20次请求)，撞到429之后错误信息里会带"Please retry in Ns"，
// 按这个提示等一下重新试，而不是第一次429就直接放弃——之前就是因为没重试，9/14条全打在配额上。
//
// 注意：timeoutMs是每次尝试单独的超时，不是传一个提前建好的AbortSignal进来——
// 429之间的等待经常要几十秒，如果所有重试共用同一个提前建好的signal，等待还没结束
// signal可能就先过期了，导致重试请求刚发出去就被自己的超时打断。所以每次重试都单独
// 建一个新的timeout signal。
async function fetchWithRetry(url, options, timeoutMs, { maxRetries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 429) return res;

    const bodyText = await res.text();
    if (attempt >= maxRetries) {
      throw new Error(`HTTP 429 ${bodyText} (重试${maxRetries}次后仍被限流，放弃)`);
    }
    const m = bodyText.match(/retry in ([\d.]+)s/i);
    const waitSec = m ? Math.ceil(Number(m[1])) + 1 : Math.min(2 ** attempt * 3, 30);
    console.error(`[限流] 429，${waitSec}秒后重试(第${attempt + 1}/${maxRetries}次)...`);
    await new Promise((r) => setTimeout(r, waitSec * 1000));
  }
}

async function geminiValidate(imageBuffer, candidates, geminiApiKey, category) {
  const res = await fetchWithRetry(
    GEMINI_URL,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": geminiApiKey,
        "Content-Type": "application/json",
        Connection: "close",
      },
      body: JSON.stringify({
        model: MODEL,
        input: [
          { type: "text", text: buildValidationPrompt(candidates, category) },
          { type: "image", data: imageBuffer.toString("base64"), mime_type: "image/jpeg" },
        ],
        // 注意：这次不带 tools，不用google_search grounding —— Lens已经做完视觉匹配了，
        // Gemini只需要看图+推理，不用联网搜索，快很多。
      }),
    },
    GEMINI_TIMEOUT_MS
  );

  if (!res.ok) {
    throw new Error(`Gemini请求失败: HTTP ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  const modelOutput = json.steps?.find((s) => s.type === "model_output");
  const textItem = modelOutput?.content?.find((c) => c.type === "text");
  if (!textItem) throw new Error("Gemini返回里没找到文本输出");

  const parsed = extractJsonBlock(textItem.text);
  if (!parsed) {
    throw new Error(`没能从Gemini输出里解析出JSON结果，原始输出: ${textItem.text.slice(0, 300)}`);
  }
  return parsed;
}

// ---------- 第三步(兜底)：Lens视觉匹配没找到带价格的有效结果，但已经确认了型号(modelGuess)时，
// 直接拿型号名去搜零售价。
//
// 这里原来用的是 Gemini 的 google_search grounding 工具，实测免费层key一调grounding就429——
// 免费层对"generateContent"这种普通推理调用配额还算够用(批处理14条跑下来没问题)，但grounding
// 这个工具几乎一用就被限流，大概率是没挂billing的纯免费key，grounding这块的免费额度是0或者
// 接近0，重试也没用(不是等一下就恢复，是这把key本来就没资格用)。
// 换成SerpApi的Google Shopping引擎——反正Lens也是打SerpApi，同一个账号同一个额度池，
// 不用再单独看Gemini grounding的脸色，而且Shopping本来就是干"查这个商品卖多少钱"这件事的，
// 比拿Gemini生成的搜索结果解析更直接。 ----------

function looksLikeAccessory(title, accessoryKeywords) {
  const t = (title ?? "").toLowerCase();
  return (accessoryKeywords ?? []).some((kw) => t.includes(kw.toLowerCase()));
}

// 从modelGuess里挑出"有区分度"的词(去掉品牌/品类这类太泛的词，比如"Segway"/"Ninebot"/"Scooter"，
// 具体列表由category.genericBrandWords决定，不同品类的泛用词完全不一样)，用来判断Shopping搜索
// 结果的标题是不是真的对应这个型号，而不是随便一个同品牌的其它型号。
function distinctiveTokens(modelGuess, genericBrandWords) {
  const genericSet = new Set((genericBrandWords ?? []).map((w) => w.toLowerCase()));
  return (modelGuess ?? "")
    .split(/[\s/()]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !genericSet.has(w.toLowerCase()));
}

// Lens候选里有些是真正对的匹配，但没带inline价格(price:null)——常见于冷门/白牌商品，
// Lens索引到了具体的Amazon商品页，但那次抓取没带上价格。这种情况候选本身的链接已经指向了
// 精确的商品页，直接用链接里的ASIN查那一件商品的价格，比丢掉链接信息、拿型号名重新盲搜
// (serpApiPriceSearch)准得多——盲搜靠标题关键词匹配，遇到没被该地区Shopping收录的白牌商品
// 容易搜空(实测过：Riuiio这种亚马逊白牌滑板车，gl=ca的Shopping搜索完全查不到，但Lens候选给的
// amazon.com链接里的ASIN一查就有价格)。
function parseAmazonLink(link) {
  if (!link) return null;
  const m = link.match(/amazon\.(ca|com)\/.*?\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  if (!m) return null;
  return { domain: `amazon.${m[1].toLowerCase()}`, asin: m[2] };
}

async function amazonAsinPrice(asin, domain, serpApiKey) {
  const params = new URLSearchParams({
    api_key: serpApiKey,
    engine: "amazon_product",
    amazon_domain: domain,
    asin,
  });
  const res = await fetch(`https://serpapi.com/search?${params}`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`SerpApi Amazon商品查询失败: HTTP ${res.status}`);
  const json = await res.json();
  if (json.search_metadata?.status !== "Success") return null;
  const p = json.product_results;
  if (!p || !Number.isFinite(p.extracted_price) || p.extracted_price <= 0) return null;
  return {
    source: `Amazon (${domain})`,
    price: p.extracted_price,
    currency: domain.endsWith(".ca") ? "CAD" : "USD", // amazon.com来的是美元，跟USD零售参考一样走FX换算
    link: p.link ?? `https://www.${domain}/dp/${asin}`,
  };
}

async function serpApiPriceSearch(modelGuess, serpApiKey, category) {
  const params = new URLSearchParams({
    api_key: serpApiKey,
    engine: "google_shopping",
    q: modelGuess,
    gl: "ca", // 加拿大地区结果，天然CAD报价
    hl: "en",
  });
  const res = await fetch(`https://serpapi.com/search?${params}`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`SerpApi Shopping搜索失败: HTTP ${res.status}`);
  const json = await res.json();
  if (json.search_metadata?.status !== "Success") return [];

  const tokens = distinctiveTokens(modelGuess, category.genericBrandWords);
  const results = json.shopping_results ?? [];

  // 标题里要包含modelGuess的关键词(区分度高的那部分)，避免把同品牌的别的型号也算进来——
  // 没有区分度词(比如modelGuess本身就只是泛称)的话就不过滤，全都算候选；
  // 排除标题里带配件关键词的条目(哪怕型号名对得上也不是整件商品)；
  // 关键词列表覆盖不到具体零件名(比如"Folding Spring Assembly"这种)，再加一道价格下限兜底——
  // 这个品类不可能有完整商品卖这么便宜，低于这个价的基本可以断定是零件/配件，不是整件商品。
  const minPrice = category.minPlausiblePrice ?? 0;
  const matched = (tokens.length
    ? results.filter((r) => tokens.every((t) => (r.title ?? "").toLowerCase().includes(t.toLowerCase())))
    : results
  )
    .filter((r) => !looksLikeAccessory(r.title, category.accessoryKeywords))
    .filter((r) => (r.extracted_price ?? 0) >= minPrice);

  return matched.slice(0, 4).map((r) => ({
    source: r.source,
    price: r.extracted_price,
    currency: "CAD", // gl=ca 出来的价格默认按加币算
    link: r.product_link ?? r.link,
  })).filter((r) => Number.isFinite(r.price) && r.price > 0);
}

/**
 * @param {string[]} imageUrls
 * @param {object} opts
 * @param {object} opts.category  必传，见 load_category.mjs / categories/*.json——
 *   决定"在找什么品类的商品"，没传直接抛错，不猜默认品类
 * @param {string} opts.serpApiKey  不传则读 process.env.SERPAPI_API_KEY
 * @param {string} opts.geminiApiKey  不传则读 process.env.GEMINI_API_KEY
 * @param {number} opts.maxImagesToTry  默认3
 * @param {string} opts.hint  配合图片一起传给Lens的文字提示(比如listing标题里的具体型号)，帮助消歧
 * @param {string} opts.title  listing原始标题，给第0步预处理用来判断多物混卖场景，不传就跳过预处理
 * @param {string} opts.noteId  小红书笔记note_id，传了就会走本地图片归档(images/<noteId>/<序号>.jpg)，
 *   优先读本地、没有才下载，下载完顺便存本地——不传就每次都直接下载，不做归档
 * @returns {Promise<{
 *   found: boolean,
 *   modelGuess: string|null,
 *   visibleText: string|null,
 *   retailPriceRefs: Array<{source:string, price:number, currency:string, link:string}>,
 *   triedImageUrl: string|null,
 *   attempts: Array<object>,
 *   reason: string|undefined
 * }>}
 */
export async function identifyModel(imageUrls, opts = {}) {
  const {
    category,
    serpApiKey = process.env.SERPAPI_API_KEY,
    geminiApiKey = process.env.GEMINI_API_KEY,
    maxImagesToTry = 3,
    hint,
    title,
    noteId,
  } = opts;

  if (!category) throw new Error("没有传 category——见 load_category.mjs，不猜默认品类");
  if (!geminiApiKey) throw new Error("没有 Gemini key");
  // SerpApi key没有也行——没有就直接走浏览器扩展那条路(见下面lensSearchWithFallback)，
  // 有key的话优先用SerpApi(更快，不用真的开浏览器)，SerpApi失败(比如配额用完)了再自动降级。
  if (!serpApiKey) console.error("[Lens] 没有配置SerpApi key，直接走浏览器扩展查询");

  // url -> 原始序号，用来拼本地归档的cacheKey("<noteId>/<序号>")，
  // selectRelevantImages 排完序之后 url 顺序会变，但序号要对应原始image_list里的位置不能变。
  const urlToIndex = new Map(imageUrls.map((u, i) => [u, i]));
  const cacheKeyFor = (url) =>
    noteId && urlToIndex.has(url) ? `${noteId}/${urlToIndex.get(url)}` : undefined;

  // 第0步：先看一遍全部图片，挑出跟目标品类相关、信息量高的图，排好优先级，
  // 不再是盲目按原始顺序试前几张——不传title就跳过这步，直接用原始顺序(比如CLI单独调试的时候)。
  let candidateImages = imageUrls.slice(0, maxImagesToTry);
  let bufferCache = new Map();
  if (title) {
    const selection = await selectRelevantImages(imageUrls, title, geminiApiKey, noteId, category);
    candidateImages = selection.orderedUrls.slice(0, maxImagesToTry);
    bufferCache = selection.bufferCache;
  }

  const attempts = [];

  for (const url of candidateImages) {
    let buf;
    try {
      buf = bufferCache.get(url) ?? (await downloadImage(url, cacheKeyFor(url)));
    } catch (e) {
      attempts.push({ url, error: `下载失败: ${e.message}` });
      continue;
    }

    const candidateLocalPath = cacheKeyFor(url) ? path.join(IMAGES_ROOT, `${cacheKeyFor(url)}.jpg`) : undefined;
    const localImagePath = candidateLocalPath && existsSync(candidateLocalPath) ? candidateLocalPath : undefined;
    let candidates;
    try {
      candidates = await getCandidates(url, serpApiKey, hint, buf, localImagePath);
    } catch (e) {
      attempts.push({ url, error: `Lens搜索失败(SerpApi+浏览器扩展都不行): ${e.message}` });
      continue;
    }

    if (candidates.length === 0) {
      attempts.push({ url, note: "Lens没找到任何候选(视觉匹配为空)" });
      continue;
    }

    let validation;
    try {
      validation = await geminiValidate(buf, candidates, geminiApiKey, category);
    } catch (e) {
      attempts.push({ url, error: `Gemini判断失败: ${e.message}`, candidates });
      continue;
    }

    const validRefs = (validation.validIndexes ?? [])
      .map((i) => candidates[i])
      .filter(Boolean)
      .map((c) => {
        const cleaned = Number(String(c.price).replace(/[^0-9.]/g, ""));
        return {
          source: c.source,
          price: cleaned,
          currency: inferCurrency(c.link),
          link: c.link,
        };
      })
      .filter((r) => Number.isFinite(r.price) && r.price > 0);

    // 上面这轮全靠candidates自带的inline价格，可能因为没带价格全部被filter掉——
    // 这时候别急着放弃，Gemini认定为有效匹配的候选里，如果链接是Amazon商品页，
    // 直接用ASIN精确查一次那件商品的价格(见parseAmazonLink/amazonAsinPrice)。
    if (validRefs.length === 0) {
      const validCandidates = (validation.validIndexes ?? []).map((i) => candidates[i]).filter(Boolean);
      for (const c of validCandidates) {
        const parsed = parseAmazonLink(c.link);
        if (!parsed) continue;
        try {
          const ref = await amazonAsinPrice(parsed.asin, parsed.domain, serpApiKey);
          if (ref) validRefs.push(ref);
        } catch (e) {
          attempts.push({ note: `Amazon ASIN查价失败(${parsed.asin}): ${e.message}` });
        }
      }
    }

    attempts.push({
      url,
      modelGuess: validation.modelGuess,
      visibleText: validation.visibleText,
      brandUnclear: validation.brandUnclear ?? false,
      validRefs,
    });

    if (validRefs.length > 0) {
      return {
        found: true,
        modelGuess: validation.modelGuess,
        visibleText: validation.visibleText,
        retailPriceRefs: validRefs,
        triedImageUrl: url,
        attempts,
      };
    }
  }

  // Lens视觉匹配全部没找到带价格的有效结果，但只要某张图Gemini认出了型号(不要求一定读到文字，
  // 有些图靠视觉本身就能认出型号，比如ES1L那种情况)，就拿型号名去SerpApi Shopping搜一次价格兜底。
  const bestPartial = [...attempts].reverse().find((a) => a.modelGuess);
  if (bestPartial) {
    let groundedRefs = [];
    try {
      groundedRefs = await serpApiPriceSearch(bestPartial.modelGuess, serpApiKey, category);
    } catch (e) {
      attempts.push({ note: `兜底价格搜索失败: ${e.message}` });
    }
    if (groundedRefs.length > 0) {
      return {
        found: true,
        modelGuess: bestPartial.modelGuess,
        visibleText: bestPartial.visibleText,
        retailPriceRefs: groundedRefs,
        triedImageUrl: bestPartial.url,
        attempts,
        reason: "Lens候选里没有带价格的有效匹配，靠确认的型号名兜底搜到的价格(SerpApi Shopping)",
      };
    }
    return {
      found: false,
      modelGuess: bestPartial.modelGuess,
      visibleText: bestPartial.visibleText,
      retailPriceRefs: [],
      triedImageUrl: bestPartial.url,
      attempts,
      reason: `认出了型号，但Lens候选和兜底价格搜索都没找到有效价格 ${summarizeErrors(attempts)}`,
    };
  }

  // 区分两种不一样的"没结果"：图片下载/接口都正常跑完了，但证据本身就混乱、没法确认品牌
  // (candidates指向的品牌各说各话，商品本身也没拍到标记)，跟单纯"图挂了/接口出错"要分开说清楚，
  // 不能都笼统写"没能识别出型号"糊弄过去。
  const brandUnclear = attempts.some((a) => a.brandUnclear);
  return {
    found: false,
    modelGuess: null,
    visibleText: null,
    retailPriceRefs: [],
    triedImageUrl: null,
    attempts,
    reason: brandUnclear
      ? "品牌不清楚，无明显标记"
      : `试了所有候选图片，没能识别出型号 ${summarizeErrors(attempts)}`,
  };
}

// ---------- 命令行直接测试 ----------

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  const { loadEnv } = await import("./load_env.mjs");
  const { loadCategory, getCategoryIdFromArgs } = await import("./load_category.mjs");
  const { readFile } = await import("node:fs/promises");

  const env = await loadEnv();
  const noteId = process.argv[2];
  const categoryId = getCategoryIdFromArgs();
  if (!noteId || !categoryId) {
    console.error("用法: node identify_model.mjs <note_id> --category=<品类id，比如escooter>");
    process.exit(1);
  }
  const category = await loadCategory(categoryId);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // 读consolidate_notes.mjs合并去重后的持久文件，不再硬编码某一天的日期
  const jsonlPath = path.join(__dirname, "all_contents.jsonl");
  const lines = (await readFile(jsonlPath, "utf-8")).split("\n").filter(Boolean);
  const record = lines.map((l) => JSON.parse(l)).find((d) => d.note_id === noteId);
  if (!record) {
    console.error(`没找到 note_id=${noteId}`);
    process.exit(1);
  }

  const imageUrls = record.image_list.split(",");
  console.log(`测试listing: ${record.title}`);
  console.log(`图片数: ${imageUrls.length}`);

  const result = await identifyModel(imageUrls, {
    category,
    serpApiKey: env.SERPAPI_API_KEY,
    geminiApiKey: env.GEMINI_API_KEY,
    hint: record.title,
    title: record.title,
    noteId: record.note_id,
  });
  console.log(JSON.stringify(result, null, 2));
}
