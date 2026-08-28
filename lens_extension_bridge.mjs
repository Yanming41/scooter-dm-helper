// lens_extension_bridge.mjs
//
// 本地HTTP桥——connect起一个本地服务器，Chrome扩展(chrome_lens_extension/)定时轮询它
// 领任务、干完活儿把结果传回来。Node这边只需要调用 queryLensViaExtension(imagePath)
// 就能拿到结果，不用管背后怎么跟扩展通信的。
//
// 为什么走这条路而不是直接CDP连接：Google对"整个浏览器进程从一开始就是被外部自动化工具
// 启动/连接"这种情况检测很严(实测过Playwright/rebrowser-playwright/CDP直连全部被拦)，
// 但"用户真实、正常打开的Chrome里，一个扩展临时用chrome.debugger API去操作一个标签页"，
// 这属于完全正常的浏览器行为(任何扩展都能这么干)，不会被打上自动化标记——这是Claude in
// Chrome/OpenClaw能成功的根本原因，不是"工具更好"，是"浏览器身份的来源不一样"。
//
// 前置条件：
//   1. 你的Chrome要正常打开着(用你平时用的那个，不需要额外操作)
//   2. chrome_lens_extension/ 这个扩展要加载进Chrome(chrome://extensions -> 开发者模式
//      -> 加载已解压的扩展程序 -> 选这个文件夹)，装一次，常驻就行，不用每次重装
//
// 用法(作为模块)：
//   import { startBridge, queryLensViaExtension } from "./lens_extension_bridge.mjs";
//   await startBridge();
//   const result = await queryLensViaExtension("C:\\path\\to\\image.jpg");
//
// 用法(命令行测试)：
//   node lens_extension_bridge.mjs <本地图片绝对路径>

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 17893;
const HOST = "127.0.0.1";

let pendingTask = null; // { id, imagePath, resolve, reject }
let taskCounter = 0;
let serverStarted = false;

function handleRequest(req, res) {
  if (req.method === "GET" && req.url === "/task") {
    if (pendingTask) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: pendingTask.id, imagePath: pendingTask.imagePath, deadline: pendingTask.deadline }));
    } else {
      res.writeHead(204);
      res.end();
    }
    return;
  }

  if (req.method === "POST" && req.url === "/result") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (pendingTask && data.id === pendingTask.id) {
          if (data.error) {
            const err = new Error(data.error);
            err.debug = data.debug;
            pendingTask.reject(err);
          } else {
            pendingTask.resolve(data.result);
          }
          pendingTask = null;
        }
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
}

/** 启动本地桥接服务器，扩展会连这个端口。多次调用只会真正启动一次。 */
export function startBridge() {
  if (serverStarted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const server = http.createServer(handleRequest);
    server.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        // 想过"端口被占用就当已经有桥在跑、直接复用"——但那是另一个独立进程，
        // 跟这边内存里的pendingTask状态完全不共享，假装成功只会让后面的查询
        // 每次都乖乖等到超时才失败，比现在这样直接报错更难排查、更慢。
        // 老实报错，报错信息里把怎么修直接写清楚，好过悄悄装没事。
        reject(new Error(
          `端口${PORT}被占用(EADDRINUSE)——大概率是之前调试留下的僵尸进程没退干净。` +
          `手动查一下: netstat -ano | grep ${PORT}，把对应PID kill掉再重跑。`
        ));
        return;
      }
      reject(e);
    });
    server.listen(PORT, HOST, () => {
      serverStarted = true;
      resolve();
    });
    // 关键修复：不加这个的话，这个server会一直占着端口、阻止Node进程自然退出——
    // 之前反复撞到EADDRINUSE，根因就是这个：CLI测试脚本查完(哪怕超时失败)看着"结束"了，
    // 但底层node.exe进程其实一直没死，一直占着17893端口，下次一跑就撞上。
    // unref()告诉Node"这个handle不该阻止进程退出"，其它正常逻辑该干嘛干嘛，不受影响。
    server.unref();
  });
}

// 批量跑build_report.mjs处理几十条listing时，之前是查完一条立刻紧接着查下一条，
// 没有任何喘息——不是真的并发(CONCURRENCY=1本身是串行的)，但"背靠背连续开关真实浏览器
// 标签页+debugger attach"这个动作本身对系统负担不小，实测直接把电脑跑卡了。
// 这里在queryLensViaExtension外面包一层强制节流：不管调用方隔多久调一次，两次真正
// 开始查询之间强制留够MIN_INTERVAL_MS，不够就先等，让系统有机会喘口气。
const MIN_INTERVAL_MS = 8_000;
let lastFinishedAt = 0;

/**
 * 让扩展去查一张本地图片的Google Lens反向搜索结果。
 * 同一时间只支持一个任务在处理(不支持并发，扩展那边一次只开一个标签页处理)，
 * 而且跟上一次查询之间会自动留够至少 MIN_INTERVAL_MS 的间隔，不用调用方自己记得sleep。
 * @param {string} imagePath 本地图片的绝对路径
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=90000] 扩展多久没响应就当失败(检查Chrome是不是开着、扩展装没装)
 * @returns {Promise<{text: string, url: string}>}
 */
export async function queryLensViaExtension(imagePath, opts = {}) {
  const waitNeeded = lastFinishedAt + MIN_INTERVAL_MS - Date.now();
  if (waitNeeded > 0) {
    console.error(`[桥] 距上次查询不到${MIN_INTERVAL_MS / 1000}秒，先等${(waitNeeded / 1000).toFixed(1)}秒再开始，别背靠背冲击系统`);
    await new Promise((r) => setTimeout(r, waitNeeded));
  }
  try {
    return await queryLensViaExtensionOnce(imagePath, opts);
  } finally {
    lastFinishedAt = Date.now();
  }
}

function queryLensViaExtensionOnce(imagePath, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (pendingTask) {
      reject(new Error("已经有一个任务在处理中，这个桥不支持并发查询"));
      return;
    }
    const id = ++taskCounter;
    const timer = setTimeout(() => {
      if (pendingTask?.id === id) {
        pendingTask = null;
        reject(new Error(
          `超时：${timeoutMs / 1000}秒内扩展没有响应结果。检查：1) Chrome是不是开着 2) chrome_lens_extension是不是已经加载 3) chrome://extensions 里这个扩展是不是报错了`
        ));
      }
    }, timeoutMs);

    pendingTask = {
      id,
      imagePath,
      // Node这边放弃(超时)之后，扩展如果还在处理这个任务，应该主动停下来，不要傻乎乎地
      // 把几十秒的CDP流程走完才发现没人要结果了——之前吃过这个亏：连续几次超时失败，
      // 扩展那边积压了好几个"孤儿任务"在后台各跑各的，屏幕上冒出一堆Lens标签页，
      // 看着像是这一次操作出的问题，其实是历史任务迟迟才收尾。deadline传给扩展，
      // 它在关键节点会检查，过期了就直接放弃，不再继续。
      deadline: Date.now() + timeoutMs,
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    };
  });
}

// ---------- 命令行直接测试 ----------

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.error("用法: node lens_extension_bridge.mjs <本地图片绝对路径>");
    process.exit(1);
  }
  await startBridge();
  console.log(`桥接服务器已启动，监听 http://${HOST}:${PORT}`);
  console.log("等待Chrome扩展轮询领取任务...(确认Chrome开着、扩展已加载)");
  try {
    const result = await queryLensViaExtension(path.resolve(imagePath));
    console.log("\n=== 结果 ===");
    console.log("最终URL:", result.url);
    console.log("\n页面文字:\n", result.text.slice(0, 3000));
  } catch (e) {
    console.error("查询失败:", e.message);
    if (e.debug) {
      console.error("出错时的URL:", e.debug.url);
      if (e.debug.filesCheck) console.error("诊断信息:", JSON.stringify(e.debug.filesCheck));
      if (e.debug.screenshotBase64) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync("scratch_lens_ext_debug.png", Buffer.from(e.debug.screenshotBase64, "base64"));
        console.error("出错时的截图已保存: scratch_lens_ext_debug.png");
      }
    }
    process.exit(1);
  }
  process.exit(0);
}
