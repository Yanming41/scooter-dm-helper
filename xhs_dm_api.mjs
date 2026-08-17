// xhs_dm_api.mjs
//
// 给LLM(这个项目里就是Claude Code对话本身)直接调用的小红书私信API——不是常驻daemon，
// 用一次开一次浏览器、做完事就关，跟 identify_model.mjs 那种"调用即用"的模块是一个路数，
// 不是 xhs_dm_bridge.mjs 那种靠 inbox/outbox 两个文件异步通信的常驻轮询daemon。
//
// 两者共用同一套底层DOM操作(见 xhs_dm_core.mjs)，差别只在"怎么触发"：
//   - bridge：常驻挂机，自己定时轮询，发现新消息落盘，适合"没人盯着的时候也要收消息"
//   - 这个api：LLM在对话里按需调用，比如"看看XX的历史聊天记录"、"跟XX说这句话"，
//     每次调用独立开关浏览器，不常驻
//
// 【重要】sendMessage是真实发送能力，会实实在在地用你的真实账号把消息发给对方——
// 调用方(LLM/agent)在调用这个函数之前，必须已经拿到你本人对这条具体消息内容的明确同意，
// 这个模块本身不做"要不要真的发"的判断，只负责"怎么发"。
//
// 用法(作为模块)：
//   import { listConversations, getHistory, sendMessage } from "./xhs_dm_api.mjs";
//   const convs = await listConversations();
//   const history = await getHistory(convs[0].convId, { maxScrolls: 10 });
//   await sendMessage(convs[0].convId, "在的，多伦多哪边方便见面？");
//
// 用法(命令行直接测试，只读不发)：
//   node xhs_dm_api.mjs list
//   node xhs_dm_api.mjs history <conv_id> [maxScrolls]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchXhsBrowser, readConvList, readFullHistory, sendMessageViaUI } from "./xhs_dm_core.mjs";

// 每次调用独立开关浏览器，避免多次调用之间共享一个context导致状态互相干扰，
// 代价是每次调用有几秒的浏览器启动开销——对"按需查一下"这种交互式场景来说不算事。
async function withBrowser(fn) {
  const context = await launchXhsBrowser();
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    return await fn(page);
  } finally {
    await context.close();
  }
}

/**
 * 列出所有一对一私聊会话(群聊不返回)。
 * @returns {Promise<Array<{convId: string, name: string, summary: string}>>}
 */
export async function listConversations() {
  return withBrowser((page) => readConvList(page));
}

/**
 * 读一个会话的聊天记录，双方消息都有，按时间顺序(旧→新)。
 * @param {string} convId  从 listConversations() 拿到的 convId
 * @param {object} [opts]
 * @param {number} [opts.maxScrolls=0]  往上滚动加载更早消息的次数，0表示只读默认渲染出来的那段(通常是最近几十条)。
 *   想翻更早的历史就调大这个数字，每次滚动都要等懒加载，数字越大越慢。
 * @returns {Promise<Array<{from: "me"|"other", text: string}>>}
 */
export async function getHistory(convId, opts = {}) {
  return withBrowser((page) => readFullHistory(page, convId, opts));
}

/**
 * 往指定会话发一条消息——真实发送，会用你的真实账号发给对方。
 * 调用前必须已经拿到你本人对这条具体消息内容的明确同意。
 * @param {string} convId
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]  true时只打字不按回车，用来验证发送机制，不会真的发出去
 */
export async function sendMessage(convId, text, opts = {}) {
  return withBrowser((page) => sendMessageViaUI(page, convId, text, opts));
}

// ---------- 命令行直接测试(只读，不提供发送——发送必须走上面的sendMessage，显式调用) ----------

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  const cmd = process.argv[2];
  if (cmd === "list") {
    const convs = await listConversations();
    console.log(`共 ${convs.length} 个私聊会话:\n`);
    for (const c of convs) console.log(`${c.convId}\t${c.name}\t${c.summary}`);
  } else if (cmd === "history") {
    const convId = process.argv[3];
    const maxScrolls = Number(process.argv[4] ?? 0);
    if (!convId) {
      console.error("用法: node xhs_dm_api.mjs history <conv_id> [maxScrolls]");
      process.exit(1);
    }
    const history = await getHistory(convId, { maxScrolls });
    console.log(`共 ${history.length} 条消息:\n`);
    for (const m of history) console.log(`[${m.from}] ${m.text}`);
  } else {
    console.error("用法: node xhs_dm_api.mjs list | node xhs_dm_api.mjs history <conv_id> [maxScrolls]");
    process.exit(1);
  }
}
