# 识图模块 API 文档

脚本：`~/IdeaProjects/scooter-dm-helper/identify_model.mjs`

给一条 listing 的图片URL列表，识别精确型号 + 零售价参考。**这份文档记录的是当前版本**——
这个模块经历过好几版重写(纯SerpApi → Gemini+grounding单独闭环 → 现在这版混合架构)，之前的
设计思路已经不适用了，别照旧文档的说法去理解代码。

## 架构：Lens负责视觉匹配，Gemini负责读图+判断，SerpApi Shopping负责兜底查价

```
第0步(可选，传title才会跑)：Gemini 一次性看全部图片(封顶10张) + 标题
  → 判断这条帖子实际卖几件东西(防止多物混卖帖认错，比如滑板车+闲置IKEA家具一起发)
  → 把跟滑板车相关的图，按"适不适合拿去做以图搜图"排序(完整清晰展示商品本体的图优先)

第1步：SerpApi Google Lens —— 真·以图搜图(跟手动上传图片到Google搜索同一个后端)
  → 按Lens自己的视觉相似度排名，取前15条候选(不要求带价格，见下方"已知坑")

第2步：Gemini(纯视觉+推理，不用grounding) —— 读图片上的文字 + 从候选列表里判断
  哪些条目真的是"这辆整车"(排除配件/不相关商品)，参考Lens的排名顺序

第3步(兜底，Lens候选没找到带价格的匹配时才触发)：确认了型号名的话，
  拿型号名去 SerpApi Google Shopping 搜零售价(过滤掉配件关键词 + $50以下的价格，
  这两道过滤是为了排除"给这个型号用的配件/零件"这种噪音)
```

为什么不用 Gemini 自己的 `google_search` grounding 工具做兜底搜索（旧版本用过）：
免费层 key 一调用带grounding的请求就 429，普通推理(不带grounding)配额倒是够用——大概率
是没挂billing的纯免费key，grounding这块的免费额度是0或接近0，等多久重试都没用。换成
SerpApi Shopping，跟Lens共用同一个账号同一个额度池，不用再看Gemini grounding的脸色。

## 作为模块调用

```js
import { identifyModel } from "./identify_model.mjs";

const result = await identifyModel(imageUrls, {
  serpApiKey: "...",     // 不传则读 process.env.SERPAPI_API_KEY
  geminiApiKey: "...",   // 不传则读 process.env.GEMINI_API_KEY
  maxImagesToTry: 3,     // 最多试几张图(第0步排完序之后的前N张)，找到就停
  hint: "Segway Ninebot G2 Max",  // 可选，配合图片一起传给Lens的q参数帮助消歧，
                                   // 只有原文里真的有具体型号时才传，泛称不要传(见"已知坑")
  title: "多伦多dt随缘出",         // 可选，传了才会跑第0步的多图预处理
  noteId: "6a39ae4b0000000016027ca3", // 可选，传了会走本地图片归档(见下)
});
```

### `noteId` 参数 —— 本地图片归档

传了 `noteId`，所有图片下载都会先查本地 `images/<noteId>/<原始序号>.jpg` 有没有，有就直接读，
不碰网络；没有才下载，下载完顺便存一份到本地。跟 `archive_images.mjs` 用的是同一套路径规则，
如果之前已经跑过 `node archive_images.mjs` 把这条listing的图存过了，这里会直接命中本地文件。

不传 `noteId` 就每次都直接下载，不做归档(比如一次性、不在意持久化的场景)。

## 返回值

```json
{
  "found": true,
  "modelGuess": "Segway Ninebot KickScooter ES1L",
  "visibleText": "ninebot",
  "retailPriceRefs": [
    { "source": "Media Canada Technologies", "price": 499, "currency": "CAD", "link": "https://..." }
  ],
  "triedImageUrl": "http://sns-webpic-qc.xhscdn.com/...",
  "attempts": [ /* 每张试过的图的详细过程，调试用 */ ],
  "reason": "可选，找到/没找到的具体原因说明"
}
```

| 字段 | 说明 |
|---|---|
| `found` | 是否找到了型号+至少一条有效零售价 |
| `modelGuess` | Gemini判断出的具体品牌+型号，没认出来是`null` |
| `visibleText` | Gemini从图片上读到的可见文字(OCR)，没读到是`null` |
| `retailPriceRefs` | `{source, price, currency, link}` 数组，`currency`是`CAD`或`USD`(通过链接域名是不是`.ca`推断) |
| `triedImageUrl` | 实际是哪张图识别成功的 |
| `attempts` | 每张候选图的完整处理记录(下载/Lens/Gemini各步骤的结果或报错)，`report.json`不存这个字段，
  只有直接调用模块或者用CLI测试才能看到，排查问题很有用 |
| `reason` | 补充说明，尤其`found:false`的时候会说清楚是哪一步没成功 |

**不会瞎猜一个型号名**——认不出来就如实返回`found:false`，不编造。

## 命令行直接测试

```bash
node identify_model.mjs <note_id>
```

读 `all_contents.jsonl`(`consolidate_notes.mjs`合并去重后的持久文件)按`note_id`找记录，
自动传入`noteId`(会用/写本地图片归档)。这个用法方便调试单条、看完整`attempts`过程；
正式批量跑用 `build_report.mjs`。

## 已知坑

- **Lens候选别按"有没有价格"过滤**：实测Lens排名最靠前(视觉最相似)的候选经常不带inline价格，
  之前的版本要求候选必须带价格才纳入，结果把最准的候选筛掉了，Gemini只能从排名靠后、恰好带
  价格标签的候选里选，选出过"儿童款""配件"这种错误型号。现在按Lens原始排名取前15条，价格
  有没有都收，型号识别交给Gemini看图判断，价格另外用第3步兜底搜。
- **`hint`不要无脑传原始标题**：只有原文里真有具体品牌型号信息时传`hint`才有帮助(帮Lens消歧，
  实测能从"E2 Pro"这类误判掰回"G2 Max"正确答案)；原文只有"电动滑板车"这种泛称时，传泛称当
  hint反而会把Lens本来能做对的纯视觉排序搅乱。判断"原文有没有具体型号"这一步应该用
  `extract_hint.mjs`(见对应文档)，不要自己把原始标题直接当hint传。
- **Lens候选池本身不稳定**：同一张图不同时刻调用，Lens返回的候选池会不一样，这是外部接口的
  特性，选图逻辑/prompt写得再好也没法根治，只能靠多张图/多次尝试提高命中率，没法保证每次都
  identical。
- **SerpApi Shopping兜底也会混进配件/零件**：加了关键词黑名单(bag/seat/charger/part等)和
  $50价格下限过滤，但零件名千奇百怪(比如"Folding Spring Assembly")，关键词列表不可能穷举，
  价格下限是更通用的兜底，但极端情况(比如二手车架单卖)理论上还是可能漏过。
- **一条listing最多打几次外部请求**：SerpApi(Lens) 1~3次 + Gemini(判断) 1~3次(跟Lens同步) +
  Gemini(第0步预处理，只在传了title时触发) 0~1次 + SerpApi(Shopping兜底，只在Lens全部没找到
  价格时触发) 0~1次。批量跑15条，SerpApi总调用量大概在15~50次之间，免费额度(250次/月)够跑
  很多轮。
