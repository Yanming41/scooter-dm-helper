// crawl.mjs
//
// 统一入口：自动把 categories/<id>.json 的 searchKeywords 同步进 MediaCrawler 的
// config/base_config.py，然后直接调用 MediaCrawler 去抓取——不用再手动改Python配置文件、
// 不用再手动敲 uv run 命令。抓完立刻紧接着合并去重+把图片存本地(见下面注释)，
// 剩下的识图出报告交给 node ingest.mjs --category=<id>。
//
// 用法: node crawl.mjs --category=escooter
//
// 扫码登录/滑块验证这些还是需要你人工操作——浏览器窗口该弹还是会弹，这个自动化只是省掉了
// "手动改KEYWORDS+手动敲uv run命令"这一步，不是说整个抓取过程不用你管了。
//
// 为什么合并去重+存档图片也挪进来了(以前是ingest.mjs的前两步)：
// 小红书图床URL过期比想象中快(实测同一批笔记3天内就开始403)，所以要在抓取刚完成、
// 链接还新鲜的这一刻立刻存档，不能等你有空了再手动跑。这两步本身是幂等的，
// 之后跑 ingest.mjs 会再跑一遍也没关系，只是重复扫描一遍，不会重复下载。

import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCategory, getCategoryIdFromArgs } from "./load_category.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIACRAWLER_DIR = path.join(__dirname, "..", "MediaCrawler");
const BASE_CONFIG_PATH = path.join(MEDIACRAWLER_DIR, "config", "base_config.py");

export async function syncKeywords(category) {
  const content = await readFile(BASE_CONFIG_PATH, "utf-8");
  const keywordsLine = `KEYWORDS = "${category.searchKeywords.join(",")}"`;
  const updated = content.replace(/^KEYWORDS = ".*"/m, keywordsLine);
  if (!/^KEYWORDS = "/m.test(content)) {
    // 没找到 KEYWORDS 这一行，说明配置文件格式变了，不能悄悄跳过不报错
    throw new Error(`没能在 ${BASE_CONFIG_PATH} 里找到 KEYWORDS 这一行，配置文件格式可能变了，手动检查一下`);
  }
  await writeFile(BASE_CONFIG_PATH, updated, "utf-8");
  console.log(`已把 MediaCrawler 的 KEYWORDS 同步为: ${category.searchKeywords.join(",")}`);
}

function runMediaCrawler() {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "uv",
      ["run", "main.py", "--platform", "xhs", "--lt", "qrcode", "--type", "search"],
      {
        cwd: MEDIACRAWLER_DIR,
        stdio: "inherit", // 透传到当前终端——扫码登录、滑块验证需要能看到浏览器窗口/控制台输出
        shell: true, // Windows下比较稳，避免spawn找不到uv这个可执行文件
      }
    );
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`MediaCrawler退出码非0: ${code}`));
    });
    proc.on("error", reject);
  });
}

function runNodeScript(scriptName, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(__dirname, scriptName), ...args], {
      cwd: __dirname,
      stdio: "inherit",
    });
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptName} 退出码非0: ${code}`));
    });
    proc.on("error", reject);
  });
}

async function main() {
  const categoryId = getCategoryIdFromArgs();
  const category = await loadCategory(categoryId); // 没传categoryId直接抛错，不猜默认品类
  console.log(`品类: ${category.displayName} (${category.id})`);

  await syncKeywords(category);
  console.log("开始调用 MediaCrawler 抓取...\n");
  await runMediaCrawler();

  // 图片URL过期比想象中快(实测3天内就有403了)，抓完立刻趁图片链接还新鲜存本地——
  // 不等你手动分步跑。这两步本身是幂等的(consolidate去重、archive跳过已存档的)，
  // 之后跑 ingest.mjs 会再跑一遍这两步也没关系，纯粹是重复扫描不会重复下载。
  console.log("\n抓取完成，趁图片链接新鲜，立刻合并去重+存档图片...");
  await runNodeScript("consolidate_notes.mjs");
  await runNodeScript("archive_images.mjs");

  console.log(`\n全部完成。接下来跑: node ingest.mjs --category=${category.id}`);
}

const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  main().catch((e) => {
    console.error("脚本出错:", e);
    process.exit(1);
  });
}
