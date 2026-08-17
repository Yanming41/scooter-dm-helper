# 关键词提取模块

脚本：`~/IdeaProjects/scooter-dm-helper/extract_hint.mjs`

## 前提假设(写在脚本文件最开头，这里再强调一遍)

这套逻辑假设**卖家在标题/正文/评论区里自己标注的品牌型号信息是准确的**——不做真实性核验。
如果卖家写错了型号(记错、笔误、故意含糊)，这里提取出来的hint会跟着错，后续Lens消歧、
`identify_model.mjs`的判断也会被带偏。这是已知但没有处理的限制。

## 干什么用的

在把图片丢给`identify_model.mjs`识图之前，先用DeepSeek(纯文本任务，不占Gemini视觉配额)判断
标题+正文+评论区里**有没有明确的品牌型号信息**，给出对应的英文hint短语。

**关键设计点**：不是简单地"提取到什么就返回什么"，而是明确区分两种情况，因为这两种情况
在下游的处理方式完全不同：

- **原文有具体型号**(比如"Segway Ninebot G2 Max") → `hasSpecificModel: true`，这个hint后面
  会被当作Lens的`q`参数传下去帮助消歧(实测有效，见#5案例：从误判的"E2 Pro"掰回"G2 Max")
- **原文只有泛称**(比如就写"scooter"/"电动滑板车") → `hasSpecificModel: false`，下游**不会**
  把这个泛称当hint传给Lens——传一个没有区分度的词反而会把Lens本来能做对的纯视觉排序搅乱
  (实测案例：不带hint时Lens第1名就是正确的"ES1L"，带了泛用hint"electric kick scooter"之后
  反而排到了错误的"Zing C20")

## 用法

```js
import { extractHint } from "./extract_hint.mjs";

const result = await extractHint(
  { title: "...", desc: "...", comments: [{ content: "..." }, ...] },
  deepseekApiKey
);
// result: { hasSpecificModel: boolean, hint: string }
```

`comments`是`all_comments.jsonl`里按`note_id`筛出来、按`like_count`排序取前几条的评论数组
(`build_report.mjs`里已经这么做了)——评论区有时候会有型号线索(比如买家问型号、卖家回复品牌)，
标题+正文里没有的信息可能在这里补上。

## 调用方规范用法(`build_report.mjs`里的实际逻辑)

```js
const extracted = await extractHint({ title, desc, comments }, deepseekApiKey);
const hint = extracted.hasSpecificModel ? extracted.hint : undefined;
// hint 传给 identifyModel 的时候，undefined 就是"不传"，
// identify_model.mjs 内部 if (hint) 才会加 q 参数，undefined 自然跳过
```

## 已知坑

- 依赖DeepSeek的判断质量，`hasSpecificModel`偶尔会有边界case判断不准(比如原文里的型号信息
  很隐晦，或者用了不常见的缩写)，目前没有针对这个做过系统性的准确率评估。
- 只看得到MediaCrawler抓到的评论(`CRAWLER_MAX_COMMENTS_COUNT_SINGLENOTES`限制了单条笔记最多
  抓多少条评论，见`xhs_crawler_api.md`)，评论区更深的信息可能看不到。
