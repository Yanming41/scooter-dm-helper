// consolidate_notes.mjs
//
// MediaCrawler 每次跑都会按当天日期生成新的 search_contents_<日期>.jsonl / search_comments_<日期>.jsonl，
// 不同日期之间同一条帖子(同一个note_id)会重复出现——之前我们一直硬编码某一天的文件名，
// 每次重新抓完都要手动改路径，而且看不出"这条帖子是不是已经抓过了"。
//
// 这个脚本扫描 data/xhs/jsonl/ 下所有日期的文件，按 note_id / comment_id 去重合并，
// 存成两份不带日期、持久累积的文件：
//   all_contents.jsonl  —— 去重后的笔记正文
//   all_comments.jsonl  —— 去重后的评论
// 同一个note_id如果在多天出现过，保留 last_modify_ts 更新的那一份(数据更全/更新)。
//
// 用法: node consolidate_notes.mjs

import { readFile, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSONL_DIR = path.join(__dirname, "..", "MediaCrawler", "data", "xhs", "jsonl");

async function mergeByKey(filePattern, key, outFile) {
  const files = readdirSync(JSONL_DIR).filter((f) => filePattern.test(f));
  const merged = new Map();

  for (const file of files) {
    const lines = (await readFile(path.join(JSONL_DIR, file), "utf-8")).split("\n").filter(Boolean);
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // 跳过解析失败的脏行
      }
      const id = record[key];
      if (!id) continue;
      const existing = merged.get(id);
      if (!existing || (record.last_modify_ts ?? 0) >= (existing.last_modify_ts ?? 0)) {
        merged.set(id, record);
      }
    }
  }

  const outPath = path.join(__dirname, outFile);
  const outLines = [...merged.values()].map((r) => JSON.stringify(r)).join("\n");
  await writeFile(outPath, outLines + (outLines ? "\n" : ""), "utf-8");
  console.log(`${outFile}: 从 ${files.length} 个源文件合并出 ${merged.size} 条去重记录`);
  return merged.size;
}

async function main() {
  console.log(`扫描目录: ${JSONL_DIR}`);
  await mergeByKey(/^search_contents_.*\.jsonl$/, "note_id", "all_contents.jsonl");
  await mergeByKey(/^search_comments_.*\.jsonl$/, "comment_id", "all_comments.jsonl");
  console.log("完成。");
}

main().catch((e) => {
  console.error("脚本出错:", e);
  process.exit(1);
});
