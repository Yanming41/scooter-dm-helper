// ingest.mjs
//
// 链起来：consolidate_notes.mjs → archive_images.mjs → extract_listings.mjs → build_report.mjs
// 每一步都是单独spawn一个node子进程顺序执行(不是import这几个脚本的内部逻辑)——
// 这几个脚本原本就是各自独立、单独也能跑的，用子进程链起来不用改它们的内部实现，
// 也保证严格按顺序执行(不会出现三步并发交叉跑的问题)。
//
// extract_listings.mjs是2026-08-17补上的——之前 all_contents.jsonl(抓取合并结果) 跟
// listings_<id>.json(build_report.mjs真正读的、带price/location的干净结构) 之间没有自动
// 同步的脚本，导致新抓到的笔记一直进不了识图报告，是个真实的bug，不是配置遗漏。
//
// 用法: node ingest.mjs --category=escooter
//
// 不包括抓取这一步(crawl.mjs)——抓取涉及扫码登录/滑块验证这种需要你人工操作的环节，
// 跟后面这几步全自动链起来的性质不一样，保持分开。完整流程是：
//   node crawl.mjs --category=escooter   (人工介入：扫码/滑块验证)
//   node ingest.mjs --category=escooter  (全自动：合并去重→存图→提取listing→识图出报告)

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCategoryIdFromArgs } from "./load_category.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function runNodeScript(scriptName, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(__dirname, scriptName), ...args], {
      cwd: __dirname,
      stdio: "inherit",
    });
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptName} 退出码非0: ${code}，中断后面的步骤`));
    });
    proc.on("error", reject);
  });
}

async function main() {
  const categoryId = getCategoryIdFromArgs();
  if (!categoryId) {
    console.error("用法: node ingest.mjs --category=<id>，比如 --category=escooter");
    process.exit(1);
  }

  console.log("=== 1/3 合并去重(consolidate_notes.mjs) ===");
  await runNodeScript("consolidate_notes.mjs");

  console.log("\n=== 2/4 图片本地归档(archive_images.mjs) ===");
  await runNodeScript("archive_images.mjs");

  console.log(`\n=== 3/4 提取listing(extract_listings.mjs --category=${categoryId}) ===`);
  await runNodeScript("extract_listings.mjs", [`--category=${categoryId}`]);

  console.log(`\n=== 4/4 识图+算旧新比例(build_report.mjs --category=${categoryId}) ===`);
  await runNodeScript("build_report.mjs", [`--category=${categoryId}`]);

  console.log("\n全部完成。");
}

main().catch((e) => {
  console.error("脚本出错:", e);
  process.exit(1);
});
