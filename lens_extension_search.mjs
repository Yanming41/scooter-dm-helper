// lens_extension_search.mjs
//
// 把 lens_extension_bridge.mjs 拿到的原始结果(整页文字+链接列表)解析成
// identify_model.mjs 期望的candidates格式：[{index, title, source, price, link}]，
// 这样SerpApi的google_lens引擎和这条浏览器扩展路径可以互相替换，后面Gemini验证那一套
// 逻辑不用改。
//
// 为什么价格提取要在Node这边做(不在扩展的background.js里)：扩展那边只负责最基础的数据采集
// (整页文字 + 每个链接的文字/href)，DOM结构解析这种容易变、需要反复调试的逻辑放这边，
// 改一次不用重新加载扩展、不用重新等一次几十秒的完整浏览器流程，调试快得多。

import { queryLensViaExtension } from "./lens_extension_bridge.mjs";

const NAV_LINK_HOSTS = new Set([
  "support.google.com",
  "accounts.google.com",
  "policies.google.com",
  "www.google.com", // "登录"这类链接会指回google自己
]);

// 价格格式：CA$147 / $147.50 / CA$1,000 这种，带不带小数点、带不带千分位逗号都要认
const PRICE_RE = /(?:CA)?\$[\d,]+(?:\.\d+)?/;

function isNavLink(href) {
  try {
    return NAV_LINK_HOSTS.has(new URL(href).hostname);
  } catch {
    return true; // 解析不出URL的，保守起见当噪音过滤掉
  }
}

/**
 * @param {{text: string, links: Array<{text: string, href: string}>}} raw
 * @returns {Array<{index: number, title: string, source: string, price: number|null, link: string}>}
 */
export function parseLensExtensionResult(raw) {
  const bodyLines = raw.text.split("\n").map((l) => l.trim()).filter(Boolean);

  const candidates = raw.links
    .filter((l) => !isNavLink(l.href))
    .map((l) => {
      const parts = l.text.split("\n").map((p) => p.trim()).filter(Boolean);
      const source = parts[0] ?? "";
      const title = parts.slice(1).join(" ") || source; // 有些卡片只有一行文字，没有单独的来源行

      // 价格关联：在整页文字里找到这个"来源"这一行，往后最多4行内找第一个价格格式的文字。
      // 靠"来源名字这一行"当锚点定位，不是完美的(同一个来源可能出现好几次)，但对我们
      // 用途够用——后面Gemini会结合图片本身再判断一遍，这里只是给出候选，不用完全精确。
      let price = null;
      const anchorIdx = bodyLines.indexOf(source);
      if (anchorIdx !== -1) {
        for (let i = anchorIdx; i < Math.min(anchorIdx + 5, bodyLines.length); i++) {
          const m = bodyLines[i].match(PRICE_RE);
          if (m) {
            price = Number(m[0].replace(/[^0-9.]/g, ""));
            break;
          }
        }
      }

      return { title, source, price, link: l.href };
    })
    // 同一个来源+标题可能因为页面上出现多次(比如"相关搜索"区域重复引用)而重复，去重
    .filter((c, i, arr) => arr.findIndex((x) => x.link === c.link) === i)
    .map((c, index) => ({ index, ...c }));

  return candidates;
}

/**
 * 完整封装：查一张本地图片的Lens结果，直接返回identify_model.mjs能用的candidates格式。
 * 调用前必须先 startBridge() 一次(常驻整个进程生命周期即可，不用每次查询都重新起)。
 */
export async function lensSearchViaExtension(imagePath, { timeoutMs } = {}) {
  const raw = await queryLensViaExtension(imagePath, { timeoutMs });
  return parseLensExtensionResult(raw);
}
