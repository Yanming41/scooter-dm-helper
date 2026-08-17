// archive_images.mjs
//
// 小红书图床的URL是有时效的，之前一直吃这个亏——隔几个小时甚至隔一天，同一条帖子的图片URL
// 就403了，只能指望重新爬一遍、指望这条帖子还会被搜索结果收录（经常收录不到，帖子就废了）。
//
// 正确做法：图片URL最新鲜的时候(刚爬完那一刻)立刻下载存本地，以后这条帖子的图片就再也不用
// 碰小红书的服务器了，CDN链接过不过期跟我们没关系。
//
// 用法：每次跑完 consolidate_notes.mjs 之后紧接着跑一遍
//   node consolidate_notes.mjs && node archive_images.mjs
//
// 存储结构：images/<note_id>/0.jpg, 1.jpg, ...（按image_list原始顺序编号）
// 已经存在的note_id目录会跳过，不重复下载。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENTS_FILE = path.join(__dirname, "all_contents.jsonl");
const IMAGES_ROOT = path.join(__dirname, "images");

const DOWNLOAD_TIMEOUT_MS = 30_000;
const CONCURRENCY = 3;

async function downloadImageOnce(url) {
  const res = await fetch(url, {
    headers: { Referer: "https://www.xiaohongshu.com/" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// 图片URL的时效窗口很短(实测：一旦笔记掉出搜索结果，从最后一次被抓到那一刻就开始不可逆
// 过期，xsec_token同理，过期后没有补救办法——见project笔记)。窗口期内如果因为网络抖动/
// 临时限流这种瞬时性问题下载失败，可能就白白错过了唯一的机会，之后再也补不回来。
// 加个当场重试：短暂等一下再试，最多3次，尽量把"本来能下下来、但网络抖了一下"这种情况
// 兜住——对于真的已经403过期的URL，重试大概率也没用，但反正很快就会放弃，无害。
async function downloadImage(url, { maxRetries = 3, retryDelayMs = 1500 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await downloadImageOnce(url);
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw lastError;
}

function isAlreadyArchived(noteId, expectedCount) {
  const dir = path.join(IMAGES_ROOT, noteId);
  if (!existsSync(dir)) return false;
  const files = readdirSync(dir).filter((f) => /^\d+\.jpg$/.test(f));
  return files.length >= expectedCount;
}

async function archiveOne(record) {
  const imageUrls = record.image_list ? record.image_list.split(",") : [];
  if (imageUrls.length === 0) return { noteId: record.note_id, skipped: "无图片" };
  if (isAlreadyArchived(record.note_id, imageUrls.length)) {
    return { noteId: record.note_id, skipped: "已存档" };
  }

  const dir = path.join(IMAGES_ROOT, record.note_id);
  await mkdir(dir, { recursive: true });

  let saved = 0;
  for (let i = 0; i < imageUrls.length; i++) {
    const filePath = path.join(dir, `${i}.jpg`);
    if (existsSync(filePath)) {
      saved++;
      continue; // 之前下过这一张，跳过(比如上次跑到一半中断了)
    }
    try {
      const buf = await downloadImage(imageUrls[i]);
      await writeFile(filePath, buf);
      saved++;
    } catch (e) {
      console.error(`  [${record.note_id}] 第${i}张下载失败: ${e.message}`);
    }
  }
  return { noteId: record.note_id, saved, total: imageUrls.length };
}

async function runWithConcurrency(items, limit, worker) {
  let idx = 0;
  async function runOne() {
    while (idx < items.length) {
      const current = idx++;
      await worker(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
}

async function main() {
  if (!existsSync(CONTENTS_FILE)) {
    console.error(`找不到 ${CONTENTS_FILE}，先跑 node consolidate_notes.mjs`);
    process.exit(1);
  }
  await mkdir(IMAGES_ROOT, { recursive: true });

  const lines = (await readFile(CONTENTS_FILE, "utf-8")).split("\n").filter(Boolean);
  const records = lines.map((l) => JSON.parse(l));
  console.log(`共 ${records.length} 条笔记，开始归档图片...`);

  let archived = 0;
  let skipped = 0;
  await runWithConcurrency(records, CONCURRENCY, async (record) => {
    const result = await archiveOne(record);
    if (result.skipped) {
      skipped++;
    } else {
      archived++;
      console.log(`[${result.noteId}] 存档 ${result.saved}/${result.total} 张`);
    }
  });

  console.log(`\n完成：新归档 ${archived} 条，跳过(已存档/无图) ${skipped} 条。`);
  console.log(`图片存在: ${IMAGES_ROOT}`);
}

main().catch((e) => {
  console.error("脚本出错:", e);
  process.exit(1);
});
