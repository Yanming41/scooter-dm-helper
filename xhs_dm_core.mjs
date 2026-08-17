// xhs_dm_core.mjs
//
// 小红书私信自动化的底层共享逻辑——浏览器/DOM操作都在这，被两处复用：
//   - xhs_dm_bridge.mjs：常驻轮询daemon，只关心"新增的对方消息"，写inbox/outbox两个文件
//   - xhs_dm_api.mjs：直接调用式API，给LLM(这个项目里就是Claude Code对话本身)按需读写，
//     支持读完整历史(含双方消息、支持往上翻更早的)
//
// 两边共用同一套DOM读取/滚动加载/发送逻辑，不重复造轮子，也保证行为一致。
//
// 【重要】sendMessage是真实发送能力，调用方(无论是bridge还是api)自己负责在发送前
// 拿到人类的明确同意——这个模块本身不做"要不要真的发"这个判断，只负责"怎么发"。

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const USER_DATA_DIR = path.join(
  __dirname, "..", "MediaCrawler", "browser_data", "xhs_user_data_dir"
);
export const CONV_LIST_URL = "https://www.xiaohongshu.com/chat?channel_id=&channel_type=explore_feed";

// 【重要】必须跟MediaCrawler(Python版Playwright)用同一个Chrome内核可执行文件，不能各用各的默认版本——
// 之前吃过亏：Node这边的Playwright默认装的是自己那份(比如chromium-1234)，跟MediaCrawler的Python
// Playwright解析到的版本(chromium-1228)不一样，两边都往同一份 xhs_user_data_dir profile 里写过
// 之后，Chrome自带的"版本迁移"逻辑会尝试挪缓存目录，权限不够直接崩掉，还得手动清理缓存文件夹。
// 这里直接问MediaCrawler的Python venv它实际用的是哪个可执行文件，Node这边显式指定用同一个，
// 保证两边任何时候打开这份profile都是同一个内核，profile不会因为内核版本对不上而出问题。
const MEDIACRAWLER_DIR = path.join(__dirname, "..", "MediaCrawler");
const MEDIACRAWLER_PYTHON = path.join(MEDIACRAWLER_DIR, ".venv", "Scripts", "python.exe");

function resolveSharedChromiumPath() {
  if (!existsSync(MEDIACRAWLER_PYTHON)) return undefined; // MediaCrawler环境不在，退化成Node自己的默认版本
  try {
    const out = execFileSync(
      MEDIACRAWLER_PYTHON,
      ["-c", "from playwright.sync_api import sync_playwright\nwith sync_playwright() as p:\n    print(p.chromium.executable_path)"],
      { cwd: MEDIACRAWLER_DIR, encoding: "utf-8" }
    ).trim();
    return existsSync(out) ? out : undefined;
  } catch {
    return undefined; // 查不到就算了，不阻塞——退化成Node自己的默认版本，只是可能又要面对内核不一致的老问题
  }
}

// 复用MediaCrawler已登录的profile启动浏览器——跟MediaCrawler抓取不能同时跑(profile锁冲突)，
// 见 docs/xhs_dm_bridge_api.md。headless:false方便随时盯着/介入。
export async function launchXhsBrowser() {
  const executablePath = resolveSharedChromiumPath();
  if (!executablePath) {
    console.log("[警告] 没查到MediaCrawler实际用的Chrome内核路径，退化成Node自己默认下载的那份——" +
      "如果之后又出现profile版本冲突崩溃，check一下 MediaCrawler/.venv 是不是还在原来的位置");
  }
  return chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    ...(executablePath ? { executablePath } : {}),
  });
}

// ---------- 会话列表 ----------

export async function readConvList(page) {
  await page.goto(CONV_LIST_URL, { waitUntil: "domcontentloaded" });
  // 会话列表先渲染骨架屏占位，实际条目要等一下才出来，固定睡眠时间不够会读到空列表——
  // 改成等真正的条目出现，等不到也不报错(可能是真的没有会话)，最多等10秒。
  await page.locator(".xhs-im-conv-item").first().waitFor({ timeout: 10_000 }).catch(() => {});
  return page.locator(".xhs-im-conv-item").evaluateAll((items) =>
    items
      .filter((el) => el.getAttribute("data-conv-kind") !== "group") // 只处理私聊，群聊先不管
      .map((el) => ({
        convId: el.getAttribute("data-conv-id"),
        name: el.querySelector(".xhs-im-conv-item__name")?.textContent?.trim() ?? "未知用户",
        summary: el.querySelector(".xhs-im-conv-item__summary-text")?.textContent?.trim() ?? "",
      }))
  );
}

// ---------- 打开会话 + 读消息(可选往上滚动加载更早的) ----------

async function openConv(page, convId) {
  await page.goto(`https://www.xiaohongshu.com/chat/${convId}`, { waitUntil: "domcontentloaded" });
  // 之前这里等的是".xhs-im-msg-list"这个外层容器，但容器会先渲染出来、气泡是之后才懒加载进去的——
  // 等到容器就提前返回，气泡还没渲染就去读，读出来是空的(实测复现过一次)。改成直接等真正的
  // 消息气泡行出现，等不到才说明这个会话是真的没消息。
  await page
    .locator(".chat-item__bubble-row")
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(() => {});
}

// 把消息列表滚动到顶，触发懒加载更早的消息，直到条数不再增加(到头了)或者达到maxScrolls次。
// 每滚一次都等一下，给懒加载网络请求留时间。
async function scrollToLoadHistory(page, maxScrolls) {
  const container = page.locator(".xhs-im-msg-list-wrap, .xhs-im-msg-list").first();
  let prevCount = await page.locator(".chat-item__bubble").count();
  for (let i = 0; i < maxScrolls; i++) {
    await container.evaluate((el) => { el.scrollTop = 0; }).catch(() => {});
    await page.waitForTimeout(800);
    const count = await page.locator(".chat-item__bubble").count();
    if (count <= prevCount) break; // 条数没再增加，说明到会话最开头了，没有更多历史
    prevCount = count;
  }
}

// 提取当前DOM里渲染出来的全部消息气泡，双方都要，按对话顺序(旧→新)，
// 每条标出 from: "me" | "other"，卡片(分享笔记)消息转成占位文字。
function extractBubbles(page) {
  return page.locator(".chat-item__bubble-row").evaluateAll((rows) =>
    rows
      .map((row) => {
        const bubble = row.querySelector(".chat-item__bubble");
        if (!bubble) return null;
        const from = bubble.classList.contains("chat-item__bubble--me") ? "me" : "other";
        let text;
        if (bubble.classList.contains("chat-item__bubble--card")) {
          const title = bubble.querySelector(".xhs-im-bubble-card-note-title")?.textContent?.trim();
          text = title ? `[分享了笔记]${title}` : "[分享了笔记/卡片消息，读不出标题]";
        } else {
          text = bubble.querySelector(".xhs-im-bubble__text")?.textContent?.trim() ?? "[无法解析的消息类型]";
        }
        return { from, text };
      })
      .filter(Boolean)
  );
}

/**
 * 读一个会话的完整聊天记录(双方都有)，支持往上滚动加载更早的消息。
 * @param {import("playwright").Page} page
 * @param {string} convId
 * @param {object} [opts]
 * @param {number} [opts.maxScrolls=0]  往上滚动加载更早消息的最大次数，0表示只读当前默认渲染出来的那一段，
 *   不主动加载历史。数字越大能翻得越远，但也越慢(每次滚动都要等懒加载)。
 * @returns {Promise<Array<{from: "me"|"other", text: string}>>}
 */
export async function readFullHistory(page, convId, opts = {}) {
  const { maxScrolls = 0 } = opts;
  await openConv(page, convId);
  if (maxScrolls > 0) await scrollToLoadHistory(page, maxScrolls);
  return extractBubbles(page);
}

// bridge daemon专用：只要"对方发的"，给新消息diff用，不用管maxScrolls(daemon只看默认渲染的那段就够)。
export async function readOtherMessages(page, convId) {
  const all = await readFullHistory(page, convId);
  return all.filter((m) => m.from === "other").map((m) => m.text);
}

// ---------- 发送 ----------

/**
 * 往指定会话发一条消息。dryRun=true时只打字不按回车，调用方自己负责在真的要发之前
 * 已经拿到人类的明确同意——这个函数本身不做同意与否的判断。
 */
export async function sendMessageViaUI(page, convId, text, { dryRun = false } = {}) {
  await page.goto(`https://www.xiaohongshu.com/chat/${convId}`, { waitUntil: "domcontentloaded" });
  const editor = page.locator(".xhs-im-input-bar-editor").first();
  await editor.waitFor({ timeout: 10_000 });
  await editor.click();
  await page.keyboard.type(text, { delay: 30 }); // 带延迟，更像真人打字

  // 这个输入框是contenteditable，背后大概率是Vue这类框架绑定的响应式状态——
  // keyboard.type()逐字符敲出来的文字，DOM上看着是对的，但实测有一次按Enter之后
  // 消息根本没发出去(界面上也没报错，服务器大概率收到了空文本直接丢弃)，怀疑是框架内部
  // 状态没跟DOM同步。这里先打一个空格再删掉，强制再触发一轮真实的input事件，
  // 确保框架内部状态跟DOM是同步的，再按Enter。
  await page.keyboard.press("Space");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);

  if (dryRun) return { sent: false, reason: "dryRun" };

  const countBefore = await page.locator(".chat-item__bubble-row").count();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000); // 给发送请求+界面渲染留够时间，别太快就去检查/关浏览器
  const countAfter = await page.locator(".chat-item__bubble-row").count();

  // 之前吃过亏：Enter按下去、界面没报错，但消息实际没发出去(疑似框架状态没同步，服务器
  // 收到空文本丢弃了)。不能只看"按了Enter就当发出去了"，得看气泡数是不是真的多了一条。
  if (countAfter <= countBefore) {
    return { sent: false, reason: "按了Enter，但消息气泡数没有增加，大概率没发出去" };
  }

  // 确认发出去之后，再多等一下(不是确认完立刻就走)——调用方(xhs_dm_api.mjs的withBrowser)
  // 拿到返回值就会马上关浏览器，这里预留一点缓冲时间，避免刚确认完、页面还有异步收尾操作
  // 没做完就被强制关掉。
  await page.waitForTimeout(2000);
  return { sent: true };
}
