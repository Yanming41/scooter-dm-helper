// prune_dead_notes.mjs
//
// 清理"死笔记"——图片URL和xsec_token都已经过期、彻底没救的笔记(见project笔记：实测过
// 19天前的笔记，xsec_token也失效了，detail模式重新拉取直接返回"Note not found, code -510001"，
// 补救不了)。判定标准：这条笔记本来是有图的(image_list非空)，但本地images/<note_id>/目录下
// 一张都没存到——说明每次尝试archive都失败了，而且不太可能再有机会(它已经不在最新的搜索结果
// 里了，不然应该会被重新抓到、拿到新URL再试一次)。
//
// 清理范围(全品类，因为all_contents.jsonl/all_comments.jsonl是共用的)：
//   - all_contents.jsonl / all_comments.jsonl 里对应的记录
//   - 每个品类自己的 listings_<id>.json / .listings_cache_<id>.json / report_<id>.json 里
//     引用到这些note_id的条目
//   - images/<note_id>/ 空目录(反正也没存到东西)
//
// 用法: node prune_dead_notes.mjs        (先看一遍会删什么，不实际改动)
//      node prune_dead_notes.mjs --apply  (真的执行删除)

import { readFile, writeFile, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENTS_FILE = path.join(__dirname, "all_contents.jsonl");
const COMMENTS_FILE = path.join(__dirname, "all_comments.jsonl");
const IMAGES_ROOT = path.join(__dirname, "images");
const CATEGORIES_DIR = path.join(__dirname, "categories");

function findDeadNoteIds(contents) {
  const dead = [];
  for (const c of contents) {
    const imgs = c.image_list ? c.image_list.split(",") : [];
    if (imgs.length === 0) continue; // 本来就没图的不算"死"，那是另一种正常情况
    const dir = path.join(IMAGES_ROOT, c.note_id);
    const archivedCount = existsSync(dir)
      ? readdirSync(dir).filter((f) => /^\d+\.jpg$/.test(f)).length
      : 0;
    if (archivedCount === 0) dead.push(c.note_id);
  }
  return dead;
}

async function main() {
  const apply = process.argv.includes("--apply");

  const contents = (await readFile(CONTENTS_FILE, "utf-8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const deadIds = new Set(findDeadNoteIds(contents));

  console.log(`共 ${contents.length} 条笔记，判定为死笔记(有图但一张都没存到)的有 ${deadIds.size} 条:`);
  for (const id of deadIds) console.log(" -", id);

  if (!apply) {
    console.log("\n(预览模式，没有实际删除任何东西。确认无误后加 --apply 参数真的执行)");
    return;
  }

  // 1. all_contents.jsonl / all_comments.jsonl
  const keptContents = contents.filter((c) => !deadIds.has(c.note_id));
  await writeFile(CONTENTS_FILE, keptContents.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf-8");
  console.log(`\nall_contents.jsonl: ${contents.length} -> ${keptContents.length} 条`);

  if (existsSync(COMMENTS_FILE)) {
    const comments = (await readFile(COMMENTS_FILE, "utf-8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const keptComments = comments.filter((c) => !deadIds.has(c.note_id));
    await writeFile(COMMENTS_FILE, keptComments.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf-8");
    console.log(`all_comments.jsonl: ${comments.length} -> ${keptComments.length} 条`);
  }

  // 2. 每个品类自己的 listings_<id>.json / .listings_cache_<id>.json / report_<id>.json
  const categoryFiles = existsSync(CATEGORIES_DIR)
    ? readdirSync(CATEGORIES_DIR).filter((f) => f.endsWith(".json"))
    : [];
  const noteIdFromUrl = (url) => (url ?? "").match(/explore\/([a-f0-9]+)/)?.[1];

  for (const file of categoryFiles) {
    const id = path.basename(file, ".json");

    const listingsPath = path.join(__dirname, `listings_${id}.json`);
    if (existsSync(listingsPath)) {
      const listings = JSON.parse(await readFile(listingsPath, "utf-8"));
      const kept = listings.filter((l) => !deadIds.has(noteIdFromUrl(l.url)));
      if (kept.length !== listings.length) {
        await writeFile(listingsPath, JSON.stringify(kept, null, 2), "utf-8");
        console.log(`listings_${id}.json: ${listings.length} -> ${kept.length} 条`);
      }
    }

    const cachePath = path.join(__dirname, `.listings_cache_${id}.json`);
    if (existsSync(cachePath)) {
      const cache = JSON.parse(await readFile(cachePath, "utf-8"));
      let removed = 0;
      for (const noteId of Object.keys(cache)) {
        if (deadIds.has(noteId)) {
          delete cache[noteId];
          removed++;
        }
      }
      if (removed > 0) {
        await writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
        console.log(`.listings_cache_${id}.json: 删掉 ${removed} 条`);
      }
    }

    const reportPath = path.join(__dirname, `report_${id}.json`);
    if (existsSync(reportPath)) {
      const report = JSON.parse(await readFile(reportPath, "utf-8"));
      const before = report.results.length;
      const kept = report.results.filter((r) => !deadIds.has(r.noteId));
      if (kept.length !== before) {
        report.results = kept;
        await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
        console.log(`report_${id}.json: 结果 ${before} -> ${kept.length} 条`);
      }
    }
  }

  // 3. images/<note_id>/ 空目录
  for (const noteId of deadIds) {
    const dir = path.join(IMAGES_ROOT, noteId);
    if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
  }
  console.log(`\n清理完成，删掉了 ${deadIds.size} 条死笔记的空图片目录。`);
}

main().catch((e) => {
  console.error("脚本出错:", e);
  process.exit(1);
});
