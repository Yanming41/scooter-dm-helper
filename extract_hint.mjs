// extract_hint.mjs
//
// 【前提假设，写在最前面】：这套关键词提取逻辑建立在"卖家自己标注的品牌/型号信息是准确的"
// 这个假设之上——如果卖家写错了型号(记错、笔误、故意含糊)，提取出来的hint会跟着错，
// 后续Lens+Gemini的判断也会被带偏。这是当前设计没有处理的已知限制，不是bug。
//
// 通用关键词提取——不认识具体是什么品类，靠调用方传进来的category(见load_category.mjs)
// 决定提示词里怎么描述这个品类。在丢给Google Lens之前，先用LLM(DeepSeek，纯文本任务不用
// Gemini视觉配额)从标题+简介+评论区里提取型号关键词，作为Lens的 q 参数(消歧提示)。
//
// 关键设计点：q 是把双刃剑——
//   - 原文里有具体品牌型号时，传给Lens能帮它从视觉相似的候选里锁定正确分支(实测有效，见#5案例)
//   - 原文里没有型号信息、只能给泛称(比如"electric kick scooter")时，传这种没有区分度的词
//     反而会把Lens本来能做对的纯视觉排序搅乱(实测有害，见#10案例：不带q时第一名就是对的，
//     带了泛用q之后反而排到别的型号)
// 所以这里明确区分"提取到具体型号"和"只有泛称"两种情况，只有前者才应该被当成q传下去，
// 后者应该让Lens纯视觉匹配，不要传无信息量的q。

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

function buildPrompt({ title, desc, comments }, category) {
  const commentsText = comments.length
    ? comments.map((c) => `- ${c.content}`).join("\n")
    : "(无评论)";

  return `这是一条小红书上的二手${category.displayName}帖子，帮我判断原文里有没有明确的品牌/型号信息，
并提取出适合拿去做Google反向图片搜索的英文关键词短语。

标题：${title}
正文：${desc ?? "(无)"}
评论区(可能包含型号线索)：
${commentsText}

规则：
- 如果原文里能找到明确的品牌/型号信息(哪怕是拼音、缩写、英文品牌名混着中文)，翻译/整理成规范的
  英文品牌+型号，hasSpecificModel设为true
- 如果原文完全没有型号信息，只有"${category.displayName}"这种泛称，输出泛称的英文翻译(比如
  "${category.aliasesForPrompt}")，hasSpecificModel设为false——**不要为了凑一个"型号"而编造**，
  原文没有就是没有

只输出一个json代码块，不要任何其他文字：

\`\`\`json
{"hasSpecificModel": true, "hint": "具体品牌+型号的英文写法"}
\`\`\``;
}

function extractJsonBlock(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * @param {object} category  必传，见 load_category.mjs / categories/*.json
 * @returns {Promise<{hasSpecificModel: boolean, hint: string}>}
 */
export async function extractHint({ title, desc, comments = [] }, deepseekApiKey, category) {
  if (!category) throw new Error("没有传 category——见 load_category.mjs，不猜默认品类");
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: buildPrompt({ title, desc, comments }, category) }],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`DeepSeek提取关键词失败: HTTP ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  const text = json.choices[0].message.content.trim();
  const parsed = extractJsonBlock(text);
  if (!parsed) {
    throw new Error(`没能从DeepSeek输出里解析出JSON: ${text.slice(0, 200)}`);
  }
  return parsed;
}
