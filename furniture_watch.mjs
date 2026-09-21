// furniture_watch.mjs
//
// 常驻监控：每隔20分钟用广泛的meta关键词轻量抓一次小红书(不抓评论，只要正文+图)，过滤出
// 安省相关的帖子，交给Gemini(结合文字+全部图片)判断帖子里有没有：地毯 / 任意IKEA品牌中小型
// 家具 / IKEA经典三层小推车 / 电动滑板车 / 人体工学办公椅。命中的、或者Gemini自己也拿不准
// 的，通过discord_dm推送到Discord——一条帖子如果命中好几件不同的东西，每件都配一张图。
// 每条消息带"感兴趣"/"跳过"按钮，点"感兴趣"会把小红书原贴链接发回来。
//
// 2026-09-20解耦重构：本脚本不再直接内嵌discord.js的Client/Embed代码，改成通过
// ~/IdeaProjects/discord_dm 这个独立的纯传输层项目收发——跟微信那边wx_dm的设计完全一个
// 思路，靠两个文件通信(discord_dm/outbox.jsonl 写消息、discord_dm/inbox.jsonl 读按钮
// 点击事件)，本脚本完全不需要知道discord.js的任何细节。这样做的好处：
//   1. discord_dm是通用的"往Discord发消息"能力，以后别的功能(不只是小红书爬虫)也能接上用；
//   2. 两边出问题互不牵连——discord_dm挂了不会搞崩小红书这边的抓取/分类逻辑，反过来也一样；
//   3. discord_dm能同时服务多个"业务方"，不用每加一个新功能就重新写一遍Discord接入代码。
//
// 为什么最后选了Discord而不是之前的wx_dm(微信)：见 ~/IdeaProjects/wx_dm/docs/adr/0004、
// 0005——微信ClawBot的"会话窗口"限制导致bot没法真正做到"主动"推送，而且图片发送协议
// 深挖后也没打通。Discord没有这些限制，bot随时能主动发消息、发图片是原生支持。
//
// 这跟build_report.mjs那条"识型号+视觉搜索+比价"的重pipeline是分开的两件事——这里只是
// "有没有值得看的新东西"的轻量筛子，不做以图搜图/比价，找到了就是给个链接，不负责判断
// 真伪/砍价。
//
// 用法：
//   先在另一个终端常驻跑起来: cd ~/IdeaProjects/discord_dm && node discord_dm.mjs
//   node furniture_watch.mjs             常驻运行，Ctrl+C停止
//   node furniture_watch.mjs --once      只跑一轮就退出(调试用)
//   node furniture_watch.mjs --skip-crawl  跳过重新抓取，直接用现有all_contents.jsonl(调试用)

import { spawn } from "node:child_process";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCategory } from "./load_category.mjs";
import { loadEnv } from "./load_env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIACRAWLER_DIR = path.join(__dirname, "..", "MediaCrawler");
const IMAGES_DIR = path.join(__dirname, "images");
const SEEN_FILE = path.join(__dirname, "furniture_watch_state.json"); // 命中现有.gitignore的*_state.json规则
const ALL_CONTENTS_FILE = path.join(__dirname, "all_contents.jsonl");

const DISCORD_DM_DIR = path.join(__dirname, "..", "discord_dm");
const DISCORD_OUTBOX_FILE = path.join(DISCORD_DM_DIR, "outbox.jsonl");
const DISCORD_INBOX_FILE = path.join(DISCORD_DM_DIR, "inbox.jsonl");
const SENDER_NAME = "小红书爬虫";

const CATEGORY_ID = "furniture_watch";
const INTERVAL_MS = 20 * 60 * 1000; // 2026-09-20按用户要求从25分钟调成20分钟
const CRAWLER_MAX_NOTES_PER_KEYWORD = 20;
const MAX_IMAGES_PER_NOTE = 8; // 一次性传给Gemini的图片数封顶，太多张会拖慢+费token
const INBOX_POLL_MS = 3000;

// 安省相关地名——2026-09-18用真实抓取数据验证过，样本里安省相关帖子会用这些城市/简写。
// "dt自取"是多伦多当地帖子常见简写(downtown)，先加进来，后续发现漏判/误判可以再调。
const LOCATION_PATTERN =
  /安省|密西沙加|Mississauga|多伦多|Toronto|万锦|Markham|士嘉堡|Scarborough|北约克|North ?York|列治文山|Richmond ?Hill|滑铁卢|Waterloo|渥太华|Ottawa|Ontario|GTA|大多伦多|dt自取/i;

// 2026-09-20用户要求：范围还是整个安省，但密西沙加对用户来说特别方便，命中的话要
// 单独标出来(不是过滤条件，是给Discord卡片加个显眼标记，让用户一眼看出"这个我能轻松去")。
const MISSISSAUGA_PATTERN = /密西沙加|密西|Mississauga/i;

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL = "gemini-flash-lite-latest";
const GEMINI_TIMEOUT_MS = 60_000;

// ---------- Gemini 多模态分类：看文字+看图，判断命中哪些条目，每条目配一张展示图 ----------

function buildClassifyPrompt(title, desc, imageCount) {
  return `这是小红书上一条二手闲置帖子(可能是打包卖好几件东西，价格按条列在正文里)，
一共有${imageCount}张图片(按顺序编号0~${imageCount - 1})。

标题：${title}
正文：${desc}

请结合文字和图片，判断这条帖子里有没有出现以下任意一类东西(命中其中任意一类就算match，
不需要都有)——**必须真的在图片里看到，不能只凭文字里提了名字就算**：
1. 地毯(rug/carpet，铺在地上的那种，任何材质/尺寸)——**注意"毯子"/"毛毯"/"盖毯"(blanket)不算**，
   这两个词都带"毯"字但完全不是一回事，"送你一条毯子"这种不算命中。
2. 宜家(IKEA)品牌的**中小型**家具——书桌、椅子、边几/小茶几、置物架、书架、小柜子、灯具、
   衣架、镜子等自己一个人搬得动、不需要租车/找人帮忙抬的东西，只要标了"宜家"或"IKEA"都算。
   **床架、大衣柜、大沙发(超过两人座)、大餐桌这类需要拆装/多人搬运/租车才能拿走的大件，
   哪怕是IKEA品牌，也不算命中**——用户没有车，大件家具对他来说搬不走，帮不上忙。
3. 宜家经典三层金属小推车——通常是黄色/白色/绿色/薄荷绿的三层铁网带轮小推车(官方型号RÅSKOG，
   但帖子里几乎不会写型号名，可能就写"小推车"/"推车"/"三层车"，需要结合"宜家"字样一起判断)
4. 电动滑板车(electric scooter/escooter)——任意品牌都算，不限于IKEA
5. 人体工学办公椅(ergonomic office chair)——任意品牌都算，不限于IKEA，不受上面第2条的
   "大件排除"限制(椅子本身不算难搬运的大件)

帖子经常混着卖好几件不相关的东西(比如IKEA家具旁边混了婴儿车、电器、日用品)，展示图片必须是
命中的那件东西本身，不能是帖子里别的不相关物品。如果标题或正文明确写着这件东西已经卖掉了
(SOLD/已出/卖掉啦/已售)，这件具体的东西不算命中。

帖子里可能不止一件东西命中(比如同时有地毯和好几件不同的IKEA家具)——**每一件命中的东西都要
挑一张最能展示它的图片**，不要只选一张就完事，让用户能把感兴趣的东西都看一眼。

用严格JSON格式回答，不要有多余文字，也不要用markdown加粗：

\`\`\`json
{
  "verdict": "match",
  "matched_items": [
    { "item": "从正文里摘出的具体条目，比如：宜家书桌 很新很新20", "image_index": 2 }
  ],
  "reason": "一句话说明判断依据"
}
\`\`\`

verdict只能是三选一："match"(明确命中且没被标记已出)、"no_match"(明确没有，或提到的东西已经
卖掉了)、"unsure"(描述模糊，需要人工看图确认)。matched_items数组每一项对应一件命中的东西，
"image_index"是能展示它的那张图的编号；同一张图能同时展示好几件东西也可以重复用同一个编号；
没命中就matched_items给空数组。`;
}

function extractJsonBlock(text) {
  // Gemini不总是老实按```json代码块回答——有时候直接吐裸JSON，不带围栏，
  // 所以围栏匹配失败后还要退一步试试整段文本本身是不是就是合法JSON。
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // 继续往下试裸JSON
    }
  }
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

// 免费层Gemini有滚动配额，429按提示等待重试，见identify_model.mjs里同样的教训。
async function fetchWithRetry(url, options, timeoutMs, { maxRetries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 429) return res;
    const bodyText = await res.text();
    if (attempt >= maxRetries) throw new Error(`HTTP 429 ${bodyText} (重试${maxRetries}次后仍被限流)`);
    const m = bodyText.match(/retry in ([\d.]+)s/i);
    const waitSec = m ? Math.ceil(Number(m[1])) + 1 : Math.min(2 ** attempt * 3, 30);
    console.error(`[限流] 429，${waitSec}秒后重试(第${attempt + 1}/${maxRetries}次)...`);
    await new Promise((r) => setTimeout(r, waitSec * 1000));
  }
}

// 拿一条帖子的图片——优先本地已经存档过的，没有就现下(带Referer头，小红书CDN有防盗链)
// 并且顺手存到本地(以后这条帖子再被处理到就不用重新下载了)。返回的是本机文件路径数组，
// 不是buffer——discord_dm是单独进程，只能传路径，不能直接传内存里的图片数据过去。
async function loadNoteImagePaths(note) {
  const localDir = path.join(IMAGES_DIR, note.note_id);
  if (existsSync(localDir)) {
    const files = readdirSync(localDir)
      .filter((f) => /^\d+\.jpg$/.test(f))
      .sort((a, b) => parseInt(a) - parseInt(b))
      .slice(0, MAX_IMAGES_PER_NOTE);
    if (files.length > 0) return files.map((f) => path.join(localDir, f));
  }

  const urls = (note.image_list?.split(",") || []).slice(0, MAX_IMAGES_PER_NOTE);
  const paths = [];
  mkdirSync(localDir, { recursive: true });
  for (let i = 0; i < urls.length; i++) {
    try {
      const res = await fetch(urls[i], { headers: { Referer: "https://www.xiaohongshu.com/" } });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const filePath = path.join(localDir, `${i}.jpg`);
      await writeFile(filePath, buf);
      paths.push(filePath);
    } catch {
      // 单张下载失败就跳过，不影响其它图
    }
  }
  return paths;
}

// 图片buffer转base64要读文件内容，跟上面拿路径是两件事——Gemini分类需要图片的实际字节，
// discord_dm发送需要的是文件路径，两边用途不一样所以分开两个函数，不合并。
async function loadImageBuffersFromPaths(paths) {
  return Promise.all(paths.map((p) => readFile(p)));
}

async function classifyListing(title, desc, imageBufs, geminiApiKey) {
  const res = await fetchWithRetry(
    GEMINI_URL,
    {
      method: "POST",
      headers: { "x-goog-api-key": geminiApiKey, "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        input: [
          { type: "text", text: buildClassifyPrompt(title, desc, imageBufs.length) },
          ...imageBufs.map((buf) => ({ type: "image", data: buf.toString("base64"), mime_type: "image/jpeg" })),
        ],
      }),
    },
    GEMINI_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`Gemini分类失败: HTTP ${res.status}`);
  const json = await res.json();
  const modelOutput = json.steps?.find((s) => s.type === "model_output");
  const textItem = modelOutput?.content?.find((c) => c.type === "text");
  const parsed = textItem ? extractJsonBlock(textItem.text) : null;
  if (!parsed) throw new Error("Gemini没有返回有效JSON");
  return parsed;
}

// ---------- 抓取(不抓评论，只要正文+图能判断出有没有目标品类) ----------
//
// 2026-09-20实测教训：一开始为了"不让浏览器窗口一直弹出来"用了--headless true，
// 结果每一轮都要重新扫码登录——小红书的反爬风控看得出headless模式的浏览器指纹，
// 不认之前缓存的登录态，逼着每次都走一遍QR登录流程(还常常等不到扫码超时，导致
// 这一轮实际上什么都没搜到，全部安静地失败)。改回不带--headless参数(用
// base_config.py里默认的HEADLESS=False)，虽然每轮会弹一次可见的浏览器窗口，
// 但登录态能正常复用，不会隔三差五又弹二维码要求重新扫码。
function runMediaCrawlerLight(keywords) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "uv",
      [
        "run",
        "main.py",
        "--platform",
        "xhs",
        "--lt",
        "qrcode",
        "--type",
        "search",
        "--keywords",
        keywords.join(","),
        "--get_comment",
        "false",
        "--crawler_max_notes_count",
        String(CRAWLER_MAX_NOTES_PER_KEYWORD),
      ],
      { cwd: MEDIACRAWLER_DIR, shell: true, stdio: "inherit" } // inherit：MediaCrawler自己的日志(包括登录提示)直接透传到furniture_watch.log里，用户能看到
    );
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`MediaCrawler退出码非0: ${code}(常见原因：登录态失效需要重新扫码/验证码，去看看浏览器窗口)`));
    });
    proc.on("error", reject);
  });
}

function runConsolidate() {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(__dirname, "consolidate_notes.mjs")], { cwd: __dirname });
    let output = "";
    proc.stdout.on("data", (d) => (output += d));
    proc.stderr.on("data", (d) => (output += d));
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`consolidate退出码非0: ${code}\n${output}`))));
    proc.on("error", reject);
  });
}

// ---------- 已处理过的note_id记录(跨轮次去重，不会重复推送同一条帖子) ----------

async function loadSeen() {
  if (!existsSync(SEEN_FILE)) return new Set();
  try {
    return new Set(JSON.parse(await readFile(SEEN_FILE, "utf-8")));
  } catch {
    return new Set();
  }
}

async function saveSeen(seen) {
  await writeFile(SEEN_FILE, JSON.stringify([...seen]), "utf-8");
}

// ---------- 跟discord_dm通信：往它的outbox.jsonl写消息 ----------

async function pushToDiscord(entry) {
  await appendFile(DISCORD_OUTBOX_FILE, JSON.stringify(entry) + "\n", "utf-8");
}

async function pushListingCard(note, verdict, imagePaths) {
  const items = verdict.matched_items || [];
  const isUnsure = verdict.verdict === "unsure";
  const isMississauga = MISSISSAUGA_PATTERN.test(`${note.title}\n${note.desc}`);
  const uniqueIndexes = [...new Set(items.map((i) => i.image_index).filter((i) => typeof i === "number"))];
  const titlePrefix = isMississauga ? "📍[密西沙加] " : "";

  await pushToDiscord({
    sender: SENDER_NAME,
    title: (titlePrefix + note.title.slice(0, 250)).replace(/\n/g, " "),
    url: note.note_url,
    description: items.map((i) => i.item).join("\n") || "(没提取到具体条目，点标题看原贴)",
    colorTag: isMississauga ? "highlight" : isUnsure ? "unsure" : "match",
    fields: [{ name: "判断依据", value: verdict.reason || "(无)" }],
    images: uniqueIndexes.slice(0, 9).map((idx) => imagePaths[idx]).filter(Boolean),
    buttons: [
      { id: `interested_${note.note_id}`, label: "感兴趣", style: "Success" },
      { id: `skip_${note.note_id}`, label: "跳过", style: "Secondary" },
    ],
  });
}

// 点"感兴趣"要把小红书原贴链接发回去——每次点击现查all_contents.jsonl，文件不大，查一次很快。
async function findNoteUrl(noteId) {
  if (!existsSync(ALL_CONTENTS_FILE)) return null;
  const lines = (await readFile(ALL_CONTENTS_FILE, "utf-8")).split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const note = JSON.parse(line);
      if (note.note_id === noteId) return note.note_url;
    } catch {
      // 跳过解析失败的行
    }
  }
  return null;
}

// ---------- 监听discord_dm/inbox.jsonl里的按钮点击事件 ----------
//
// discord_dm收到点击后已经先占住了这个交互(deferReply)，本脚本这边慢慢查完link之后，
// 带上同一个interaction的token写回discord_dm的outbox，discord_dm负责真正把内容填进去。
// 两边完全不用同步等待，纯靠文件异步传消息。

let discordInboxLinesProcessed = 0;

async function checkDiscordInbox() {
  if (!existsSync(DISCORD_INBOX_FILE)) return;
  const lines = (await readFile(DISCORD_INBOX_FILE, "utf-8")).split("\n").filter(Boolean);
  if (lines.length <= discordInboxLinesProcessed) return;

  const newLines = lines.slice(discordInboxLinesProcessed);
  discordInboxLinesProcessed = lines.length;

  for (const line of newLines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "button_click") continue;

    const [action, ...idParts] = event.custom_id.split("_");
    const noteId = idParts.join("_");
    // 只处理属于本脚本发出去的按钮(interested_/skip_前缀)——inbox是discord_dm的公共信箱，
    // 以后别的功能接进来也会往同一个文件写事件，这里不认识的前缀直接忽略，不是本脚本的事。
    if (action !== "interested" && action !== "skip") continue;

    let text;
    if (action === "interested") {
      const url = await findNoteUrl(noteId);
      text = url ? `链接给你：${url}` : `没找到这条帖子的链接 (note_id=${noteId})`;
    } else {
      text = `已跳过 (note_id=${noteId})`;
    }

    await pushToDiscord({ reply_to_interaction: event.interaction, text });
    console.log(`[交互] ${action} ${noteId}`);
  }
}

// ---------- 一轮完整流程 ----------

async function runCycle(category, geminiApiKey, seen, { skipCrawl = false } = {}) {
  console.log(`[${new Date().toISOString()}] 开始新一轮抓取: ${category.searchKeywords.join(",")}`);
  if (skipCrawl) {
    // 调试用：跳过重新抓取，直接用现有的all_contents.jsonl——排查分类/推送逻辑时不用
    // 每次都真的去打小红书，节省时间也不会给账号增加不必要的抓取流量。
    console.log("[调试] --skip-crawl，跳过抓取，直接用现有all_contents.jsonl");
  } else {
    await runMediaCrawlerLight(category.searchKeywords);
    await runConsolidate();
  }

  if (!existsSync(ALL_CONTENTS_FILE)) {
    console.log("all_contents.jsonl还不存在，跳过这一轮");
    return;
  }

  const lines = (await readFile(ALL_CONTENTS_FILE, "utf-8")).split("\n").filter(Boolean);
  const candidates = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((o) => category.searchKeywords.includes(o.source_keyword))
    .filter((o) => !seen.has(o.note_id));

  console.log(`本轮发现 ${candidates.length} 条未处理过的帖子`);

  let sentCount = 0;
  for (const note of candidates) {
    seen.add(note.note_id); // 不管后面判断结果如何，处理过就标记，不会重复处理同一条
    await saveSeen(seen); // 每处理一条就存一次盘，防止中途崩溃丢进度

    const fullText = `${note.title}\n${note.desc}`;
    if (!LOCATION_PATTERN.test(fullText)) continue; // 不是安省相关，跳过，不打扰用户

    const imagePaths = await loadNoteImagePaths(note);
    const imageBufs = await loadImageBuffersFromPaths(imagePaths);
    let verdict;
    try {
      verdict = await classifyListing(note.title, note.desc, imageBufs, geminiApiKey);
    } catch (e) {
      console.error(`[分类出错] note_id=${note.note_id}:`, e.message);
      continue;
    }

    if (verdict.verdict === "no_match") continue;

    try {
      await pushListingCard(note, verdict, imagePaths);
      sentCount++;
      console.log(`[发送 ${sentCount}] ${verdict.verdict} | ${note.title.slice(0, 30)}`);
    } catch (e) {
      console.error(`[推送出错] note_id=${note.note_id}:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 400)); // 客气一点，别糊太快
  }

  console.log(sentCount > 0 ? `本轮共发送 ${sentCount} 条` : "本轮没有命中的listing，不打扰用户");
}

async function main() {
  const category = await loadCategory(CATEGORY_ID);
  const env = await loadEnv();
  const geminiApiKey = env.GEMINI_API_KEY;
  if (!geminiApiKey) throw new Error("没有 GEMINI_API_KEY，检查 .env");
  if (!existsSync(DISCORD_DM_DIR)) {
    throw new Error(`找不到discord_dm目录: ${DISCORD_DM_DIR}，检查路径；另外记得discord_dm.mjs要单独常驻跑起来`);
  }

  const seen = await loadSeen();
  console.log(`[furniture_watch] 启动，已有 ${seen.size} 条历史记录，每 ${INTERVAL_MS / 60000} 分钟跑一轮`);

  // 启动时把discordInboxLinesProcessed对齐到文件当前末尾——不处理重启之前留下的旧点击事件
  // (interaction token反正十几分钟就过期了，处理了也回复不了)。
  if (existsSync(DISCORD_INBOX_FILE)) {
    discordInboxLinesProcessed = (await readFile(DISCORD_INBOX_FILE, "utf-8")).split("\n").filter(Boolean).length;
  }
  setInterval(() => checkDiscordInbox().catch((e) => console.error("[inbox监听出错]", e.message)), INBOX_POLL_MS);

  const skipCrawl = process.argv.includes("--skip-crawl");
  const runOnce = process.argv.includes("--once");

  while (true) {
    try {
      await runCycle(category, geminiApiKey, seen, { skipCrawl });
    } catch (e) {
      console.error("本轮出错，跳过等下一轮:", e.message);
      // 抓取/分类失败大概率是需要人工介入的事(重新登录小红书、过验证码之类)，
      // 主动推个提醒到Discord，不然用户不会一直盯着终端，容易几个小时都没人发现。
      await pushToDiscord({
        sender: SENDER_NAME,
        text: `⚠️ 这一轮抓取/处理失败了，可能需要你去看看小红书是不是要求重新登录/过验证码：\n${e.message}`,
      }).catch(() => {});
    }
    if (runOnce) process.exit(0); // 常驻进程(setInterval)不会让Node自然退出，--once必须显式exit
    console.log(`等待 ${INTERVAL_MS / 60000} 分钟进入下一轮...`);
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error("脚本异常退出:", e);
  process.exit(1);
});
