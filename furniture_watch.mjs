// furniture_watch.mjs
//
// 常驻监控：每隔20分钟用广泛的meta关键词轻量抓一次小红书
// (headless、不抓评论，只要正文——这些泛类关键词一次搜出来的量不小，抓评论会拖慢每一轮)，
// 过滤出安省相关的帖子，交给Gemini(结合文字+全部图片)判断帖子里有没有：地毯 / 任意IKEA
// 品牌家具 / IKEA经典三层小推车。命中的、或者Gemini自己也拿不准的，发到Discord频道——
// 一条帖子如果命中好几件不同的东西，每件都配一张图，Discord会把共用同一个url的embed
// 自动排成图集。每条消息带"感兴趣"/"跳过"按钮，点"感兴趣"会把小红书原贴链接发回来。
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
//   node furniture_watch.mjs             常驻运行，Ctrl+C停止
//   node furniture_watch.mjs --once      只跑一轮就退出(调试用)
//   node furniture_watch.mjs --skip-crawl  跳过重新抓取，直接用现有all_contents.jsonl(调试用)

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} from "discord.js";
import { loadCategory } from "./load_category.mjs";
import { loadEnv } from "./load_env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIACRAWLER_DIR = path.join(__dirname, "..", "MediaCrawler");
const IMAGES_DIR = path.join(__dirname, "images");
const SEEN_FILE = path.join(__dirname, "furniture_watch_state.json"); // 命中现有.gitignore的*_state.json规则
const ALL_CONTENTS_FILE = path.join(__dirname, "all_contents.jsonl");

const CATEGORY_ID = "furniture_watch";
const INTERVAL_MS = 20 * 60 * 1000; // 2026-09-20按用户要求从25分钟调成20分钟
const CRAWLER_MAX_NOTES_PER_KEYWORD = 20;
const MAX_IMAGES_PER_NOTE = 8; // 一次性传给Gemini的图片数封顶，太多张会拖慢+费token

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
不需要三类都有)——**必须真的在图片里看到，不能只凭文字里提了名字就算**：
1. 地毯(rug/carpet，铺在地上的那种，任何材质/尺寸)——**注意"毯子"/"毛毯"/"盖毯"(blanket)不算**，
   这两个词都带"毯"字但完全不是一回事，"送你一条毯子"这种不算命中。
2. 宜家(IKEA)品牌的**中小型**家具——书桌、椅子、边几/小茶几、置物架、书架、小柜子、灯具、
   衣架、镜子等自己一个人搬得动、不需要租车/找人帮忙抬的东西，只要标了"宜家"或"IKEA"都算。
   **床架、大衣柜、大沙发(超过两人座)、大餐桌这类需要拆装/多人搬运/租车才能拿走的大件，
   哪怕是IKEA品牌，也不算命中**——用户没有车，大件家具对他来说搬不走，帮不上忙。
3. 宜家经典三层金属小推车——通常是黄色/白色/绿色/薄荷绿的三层铁网带轮小推车(官方型号RÅSKOG，
   但帖子里几乎不会写型号名，可能就写"小推车"/"推车"/"三层车"，需要结合"宜家"字样一起判断)

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

// 拿一条帖子的图片——优先本地已经archive_images.mjs存档过的，没有就现下(带Referer头，
// 小红书CDN有防盗链)。这里是刚抓完就立刻处理，图片链接还很新鲜，不用担心过期。
async function loadNoteImages(note) {
  const localDir = path.join(IMAGES_DIR, note.note_id);
  if (existsSync(localDir)) {
    const files = readdirSync(localDir)
      .filter((f) => /^\d+\.jpg$/.test(f))
      .sort((a, b) => parseInt(a) - parseInt(b))
      .slice(0, MAX_IMAGES_PER_NOTE);
    if (files.length > 0) {
      return Promise.all(files.map((f) => readFile(path.join(localDir, f))));
    }
  }

  const urls = (note.image_list?.split(",") || []).slice(0, MAX_IMAGES_PER_NOTE);
  const bufs = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { Referer: "https://www.xiaohongshu.com/" } });
      if (res.ok) bufs.push(Buffer.from(await res.arrayBuffer()));
    } catch {
      // 单张下载失败就跳过，不影响其它图
    }
  }
  return bufs;
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

// ---------- 轻量抓取(headless、不抓评论，只要正文+图能判断出有没有目标品类) ----------

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
        "--headless",
        "true",
        "--get_comment",
        "false",
        "--crawler_max_notes_count",
        String(CRAWLER_MAX_NOTES_PER_KEYWORD),
      ],
      { cwd: MEDIACRAWLER_DIR, shell: true }
    );
    let output = "";
    proc.stdout.on("data", (d) => (output += d));
    proc.stderr.on("data", (d) => (output += d));
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`MediaCrawler退出码非0: ${code}\n${output.slice(-2000)}`));
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

// ---------- 发到Discord：embed+图集+按钮 ----------

async function sendToDiscord(channel, note, verdict) {
  const items = verdict.matched_items || [];
  const isUnsure = verdict.verdict === "unsure";
  const isMississauga = MISSISSAUGA_PATTERN.test(`${note.title}\n${note.desc}`);
  const imageBufs = await loadNoteImages(note);

  // 同一张图可能被好几件东西共用，去重后按出现顺序排——多个embed共用同一个url，
  // Discord会自动把它们当成同一张卡片的"图集"，横向grid展示。
  const uniqueIndexes = [...new Set(items.map((i) => i.image_index).filter((i) => typeof i === "number"))];

  const titlePrefix = isMississauga ? "📍[密西沙加] " : "";
  const mainEmbed = new EmbedBuilder()
    .setColor(isMississauga ? 0x3498db : isUnsure ? 0xf1c40f : 0x00b894)
    .setTitle((titlePrefix + note.title.slice(0, 250)).replace(/\n/g, " "))
    .setURL(note.note_url)
    .setDescription(items.map((i) => i.item).join("\n") || "(没提取到具体条目，点标题看原贴)")
    .addFields({ name: "判断依据", value: verdict.reason || "(无)" })
    .setFooter({ text: isUnsure ? "小红书爬虫 · 拿不准，人工确认一下" : "小红书爬虫" })
    .setTimestamp();

  const files = [];
  const embeds = [mainEmbed];
  uniqueIndexes.slice(0, 9).forEach((idx, i) => {
    const buf = imageBufs[idx];
    if (!buf) return;
    const filename = `listing${i}.jpg`;
    files.push(new AttachmentBuilder(buf, { name: filename }));
    if (i === 0) mainEmbed.setImage(`attachment://${filename}`);
    else embeds.push(new EmbedBuilder().setURL(note.note_url).setImage(`attachment://${filename}`));
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`interested_${note.note_id}`).setLabel("感兴趣").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`skip_${note.note_id}`).setLabel("跳过").setStyle(ButtonStyle.Secondary)
  );

  await channel.send({ embeds, components: [row], files });
}

// 点"感兴趣"要把小红书原贴链接发回去——不在内存里存note_id->url映射(进程重启就丢了)，
// 每次点击现查all_contents.jsonl，文件不大，查一次很快。
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

function registerInteractionHandler(client) {
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    const [action, ...idParts] = interaction.customId.split("_");
    const noteId = idParts.join("_");

    if (action === "interested") {
      const url = await findNoteUrl(noteId);
      await interaction.reply({
        content: url ? `链接给你：${url}` : `没找到这条帖子的链接 (note_id=${noteId})`,
        ephemeral: true,
      });
    } else if (action === "skip") {
      await interaction.reply({ content: `已跳过 (note_id=${noteId})`, ephemeral: true });
    }
    console.log(`[交互] ${action} ${noteId}`);
  });
}

// ---------- 一轮完整流程 ----------

async function runCycle(category, geminiApiKey, seen, channel, { skipCrawl = false } = {}) {
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
    if (!LOCATION_PATTERN.test(fullText)) continue; // 不是密西沙加/dt相关，跳过，不打扰用户

    const imageBufs = await loadNoteImages(note);
    let verdict;
    try {
      verdict = await classifyListing(note.title, note.desc, imageBufs, geminiApiKey);
    } catch (e) {
      console.error(`[分类出错] note_id=${note.note_id}:`, e.message);
      continue;
    }

    if (verdict.verdict === "no_match") continue;

    try {
      await sendToDiscord(channel, note, verdict);
      sentCount++;
      console.log(`[发送 ${sentCount}] ${verdict.verdict} | ${note.title.slice(0, 30)}`);
    } catch (e) {
      console.error(`[Discord发送出错] note_id=${note.note_id}:`, e.message);
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
  const { DISCORD_TOKEN, DISCORD_CHANNEL_ID } = env;
  if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID) throw new Error("没有 DISCORD_TOKEN/DISCORD_CHANNEL_ID，检查 .env");

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions],
  });
  registerInteractionHandler(client);
  await client.login(DISCORD_TOKEN);
  await new Promise((resolve) => client.once("clientReady", resolve));
  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
  console.log(`[Discord] 已登录 ${client.user.tag}，频道已就绪`);

  const seen = await loadSeen();
  console.log(`[furniture_watch] 启动，已有 ${seen.size} 条历史记录，每 ${INTERVAL_MS / 60000} 分钟跑一轮`);

  const skipCrawl = process.argv.includes("--skip-crawl");
  const runOnce = process.argv.includes("--once");

  while (true) {
    try {
      await runCycle(category, geminiApiKey, seen, channel, { skipCrawl });
    } catch (e) {
      console.error("本轮出错，跳过等下一轮:", e.message);
    }
    if (runOnce) {
      // Discord的Gateway连接是常驻WebSocket，不主动退出进程的话，光break出循环
      // 并不会让Node自然退出——--once是调试用的，必须显式exit。
      process.exit(0);
    }
    console.log(`等待 ${INTERVAL_MS / 60000} 分钟进入下一轮...`);
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error("脚本异常退出:", e);
  process.exit(1);
});
