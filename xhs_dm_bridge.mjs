// xhs_dm_bridge.mjs
//
// 小红书私信的传输层——跟 wechat_bridge.mjs 是同一个思路：只负责收发，不含任何起草/agent逻辑，
// 起草交给外部agent(这个项目里就是Claude Code对话本身)对着 xhs_inbox.jsonl / xhs_outbox.jsonl
// 读写。
//
// 跟wechat_bridge.mjs的关键差异：
//   1. 小红书私信没有WeChat ClawBot那种"独立bot身份"的官方产品，这里驱动的是你自己的真实
//      小红书账号——发出去的消息就是"你"发的，不是一个隔离的机器人身份。
//   2. 小红书的接口(会话列表/聊天记录)需要页面内部专有的签名逻辑，直接拿URL重放会被拒
//      (实测调用会返回 result:-7)。所以这里不走接口，改成纯DOM读取+真实点击/打字——
//      跟人用浏览器操作是一个原理，不去逆向签名算法。
//   3. 复用 MediaCrawler 已经登录过的浏览器profile(browser_data/xhs_user_data_dir)，
//      不用重新扫码——代价是这个脚本跑起来的时候，不能同时跑 MediaCrawler 抓取
//      (Chromium的profile文件锁着，两边抢会冲突)。
//
// 用法：
//   node xhs_dm_bridge.mjs
//   首次运行会打开一个真实浏览器窗口(不是无头模式，方便你随时盯着/介入)。
//   之后常驻运行，两个循环并行：
//     - 定期检查会话列表有没有新消息 -> 写 xhs_inbox.jsonl
//     - 轮询 xhs_outbox.jsonl 新增行 -> 打开对应会话，打字发送
//
// 安全阀：设置环境变量 XHS_DM_DRY_RUN=1 时，发送步骤只会把文字打进输入框，不会真的按回车
// 发出去——留给你自己确认一下"发送是不是按回车触发的"这件事，验证过一次之后再关掉这个开关。

import { readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchXhsBrowser, readConvList, readOtherMessages, sendMessageViaUI } from "./xhs_dm_core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STATE_FILE = path.join(__dirname, ".xhs_dm_state.json");
const INBOX_FILE = path.join(__dirname, "xhs_inbox.jsonl");
const OUTBOX_FILE = path.join(__dirname, "xhs_outbox.jsonl");

const POLL_MS = 15_000; // 私信不用像抢购一样高频轮询，15秒一次足够，也更不像机器人
const OUTBOX_POLL_MS = 2_000;
const DRY_RUN = process.env.XHS_DM_DRY_RUN === "1";

// ---------- 状态持久化 ----------
// seenCounts: { [convId]: 上次看到的"对方消息"条数 } —— 用来判断新消息，不依赖接口返回的msgId
//             (DOM读取拿不到真正的消息ID，只能数条数)
// pending:    { [inboxMsgId]: { convId, fromName } } —— outbox回复时用来查回该发到哪个会话
// convSignature: { [convId]: 上次看到的会话列表预览文字签名 } —— 用来判断要不要点进去细看

async function loadState() {
  if (existsSync(STATE_FILE)) return JSON.parse(await readFile(STATE_FILE, "utf-8"));
  return { seenCounts: {}, pending: {}, convSignature: {}, outbox_lines_processed: 0 };
}
async function saveState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// DOM读取/滚动加载/发送这些底层操作都挪到 xhs_dm_core.mjs 了，跟 xhs_dm_api.mjs 共用，
// 这边只保留"轮询节奏+新消息判断+落盘"这些daemon特有的逻辑。

// ---------- 循环一：扫会话列表 -> 发现新消息 -> 写 xhs_inbox.jsonl ----------

async function inboxLoop(context, state) {
  console.log("[inbox] 开始轮询小红书私信...");
  const page = await context.newPage();
  while (true) {
    try {
      const convs = await readConvList(page);
      for (const conv of convs) {
        if (!conv.convId) continue;
        const prevSig = state.convSignature[conv.convId];
        if (prevSig === conv.summary) continue; // 预览文字没变，跳过，不用点进去细看
        state.convSignature[conv.convId] = conv.summary;

        const others = await readOtherMessages(page, conv.convId);
        const seenCount = state.seenCounts[conv.convId];
        if (seenCount === undefined) {
          // 第一次见到这个会话——把当前消息数当基线，不要把整段历史当"新消息"倒进inbox里，
          // 只关心从现在开始新收到的。
          state.seenCounts[conv.convId] = others.length;
          continue;
        }
        const newOnes = others.slice(seenCount);
        state.seenCounts[conv.convId] = others.length;

        for (const text of newOnes) {
          const id = randomUUID();
          state.pending[id] = { convId: conv.convId, fromName: conv.name };
          const record = { id, ts: Date.now(), platform: "xhs", from_user_id: conv.convId, from_name: conv.name, text };
          await appendFile(INBOX_FILE, JSON.stringify(record) + "\n", "utf-8");
          console.log(`[inbox] ${conv.name} -> ${id}: ${text.slice(0, 30)}`);
        }
      }
      await saveState(state);
    } catch (e) {
      console.error("[inbox] 轮询出错，跳过这一轮:", e.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// ---------- 循环二：轮询 xhs_outbox.jsonl -> 打开对应会话 -> 打字发送 ----------

async function outboxLoop(context, state) {
  console.log("[outbox] 开始监听 xhs_outbox.jsonl ...");
  if (DRY_RUN) console.log("[outbox] DRY_RUN模式开启：只会把文字打进输入框，不会真的按回车发送");
  const page = await context.newPage();
  while (true) {
    await new Promise((r) => setTimeout(r, OUTBOX_POLL_MS));
    try {
      if (!existsSync(OUTBOX_FILE)) continue;
      const content = await readFile(OUTBOX_FILE, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length <= state.outbox_lines_processed) continue;

      const newLines = lines.slice(state.outbox_lines_processed);
      for (const line of newLines) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          console.error("[outbox] 跳过一行无法解析的内容:", line);
          continue;
        }

        const target = state.pending[entry.reply_to];
        if (!target) {
          console.error(`[outbox] 找不到 reply_to=${entry.reply_to} 对应的会话，跳过`);
          continue;
        }

        const result = await sendMessageViaUI(page, target.convId, entry.text, { dryRun: DRY_RUN });

        if (!result.sent) {
          console.log(`[outbox] (DRY_RUN，未发送) 已把文字打进跟${target.fromName}的对话框，你自己看一眼按不按回车: ${entry.text.slice(0, 30)}`);
        } else {
          console.log(`[outbox] 已发送给 ${target.fromName} (reply_to=${entry.reply_to})`);
          delete state.pending[entry.reply_to];
        }
      }
      state.outbox_lines_processed = lines.length;
      await saveState(state);
    } catch (e) {
      console.error("[outbox] 处理出错，跳过这一轮:", e.message);
    }
  }
}

// ---------- 入口 ----------

async function main() {
  const state = await loadState();
  console.log("复用MediaCrawler的登录会话(browser_data/xhs_user_data_dir)");
  console.log("(注意：这个profile跟MediaCrawler共用，两边不能同时跑)");

  const context = await launchXhsBrowser();

  await Promise.all([inboxLoop(context, state), outboxLoop(context, state)]);
}

main().catch((e) => {
  console.error("脚本异常退出:", e);
  process.exit(1);
});
