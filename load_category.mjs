// load_category.mjs
//
// 这个项目不是只给电动滑板车用的——以后各种品类的二手商品都会用这套流水线定期搜小红书。
// 所有跟"具体在找什么东西"相关的内容(搜索关键词、提示词里怎么描述这个品类、拿来排除配件的
// 关键词、判断"这个价格不可能是整件商品"的价格下限)都不该写死在代码里，统一从
// categories/<id>.json 读，代码本身只认"category"这个抽象概念。
//
// 用法：
//   node build_report.mjs --category=escooter
//   或者设环境变量 CATEGORY=escooter
// 不传就报错，不猜默认值——写死一个默认品类等于换了个方式硬编码，没有解决问题。

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATEGORIES_DIR = path.join(__dirname, "categories");

export function getCategoryIdFromArgs(argv = process.argv) {
  const flag = argv.find((a) => a.startsWith("--category="));
  return flag ? flag.split("=")[1] : process.env.CATEGORY;
}

/**
 * @param {string} categoryId  比如 "escooter"
 * @returns {Promise<{
 *   id: string,
 *   displayName: string,
 *   aliasesForPrompt: string,
 *   searchKeywords: string[],
 *   genericBrandWords: string[],
 *   accessoryKeywords: string[],
 *   minPlausiblePrice: number
 * }>}
 */
export async function loadCategory(categoryId) {
  if (!categoryId) {
    throw new Error(
      "没指定品类——传 --category=<id> 或者设环境变量 CATEGORY，比如 --category=escooter。" +
        `可用品类看 ${CATEGORIES_DIR} 目录下有哪些 .json 文件。`
    );
  }
  const filePath = path.join(CATEGORIES_DIR, `${categoryId}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`没找到品类配置 ${filePath}，先在 categories/ 下建一个`);
  }
  return JSON.parse(await readFile(filePath, "utf-8"));
}
