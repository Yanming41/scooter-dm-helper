# 微信 ClawBot 传输层 API 文档

脚本：`~/IdeaProjects/scooter-dm-helper/wechat_bridge.mjs`

**这个脚本只做微信收发的传输，不含任何起草/agent逻辑。** 它是常驻进程，跟外部agent之间
靠两个文件通信，agent不需要知道任何微信/iLink协议细节。

## 启动

```bash
cd ~/IdeaProjects/scooter-dm-helper
node wechat_bridge.mjs
```

无需额外环境变量（DeepSeek key之类的东西已经从这个脚本里拆出去了，那是agent自己的事）。

首次运行会弹出/保存二维码图片（`qrcode.png`），需要用微信扫码绑定 bot 频道（不是登录你的微信主账号）。
绑定后 `bot_token` 会存进 `.wechat_state.json`，之后重启不需要再扫码，除非这个文件被删了或token失效。

脚本要**一直挂着跑**才能收发消息，不是跑一次就退出的类型。

## 对外接口：两个 jsonl 文件

都在脚本所在目录下，每行一个 JSON 对象（[JSON Lines](https://jsonlines.org/) 格式）。

### `inbox.jsonl` —— 本脚本写，agent 读

微信收到新消息时，本脚本会追加一行到这个文件末尾：

```json
{"id": "550e8400-...", "ts": 1755230000000, "from_user_id": "o9cq800kum_xxx@im.wechat", "text": "帮我看看那个多伦多滑板车的行情"}
```

| 字段 | 说明 |
|---|---|
| `id` | 这条消息的唯一ID(uuid)，**回复时要用这个**，不是`from_user_id` |
| `ts` | 收到时间，毫秒时间戳 |
| `from_user_id` | 微信那边的用户标识，agent不需要用到，纯记录 |
| `text` | 消息文本内容 |

agent 消费方式：追加读取新行（比如记录自己上次读到第几行，或者用 `tail -f` 式监听），
**每条只处理一次**，本脚本不会做去重，重复处理是 agent 自己要注意的。

> 目前只处理文本消息。图片/语音/文件类型的消息会被静默跳过，不会出现在 inbox.jsonl 里。

### `outbox.jsonl` —— agent 写，本脚本读

agent 想回复时，追加一行到这个文件：

```json
{"reply_to": "550e8400-...", "text": "这是我起草的回复内容"}
```

| 字段 | 说明 |
|---|---|
| `reply_to` | 对应 `inbox.jsonl` 里那条消息的 `id`，本脚本靠这个查回该发给谁 |
| `text` | 要发送的文本内容 |

本脚本每秒轮询一次这个文件，发现新行就尝试发送。发送成功后会在自己内部状态里清掉对应的
pending 记录；如果 `reply_to` 对应不上（比如id写错、或者对应的消息已经被回复过一次），
会在控制台打印错误并跳过这一行，**不会重试，也不会报错给agent**——agent自己要检查发送有没有
成功（简单办法：看脚本的 stdout 日志，或者在 `text` 里带一个自己能识别的标记做核对）。

## 状态文件（agent不需要碰，了解即可）

`.wechat_state.json`：

```json
{
  "bot_token": "...",
  "get_updates_buf": "...",
  "pending": { "<inbox消息id>": { "to_user_id": "...", "context_token": "..." } },
  "outbox_lines_processed": 12
}
```

这个文件是脚本自己的内部记账，删掉会导致重新扫码登录（`bot_token`丢失）以及 `outbox.jsonl`
从头重新处理一遍（`outbox_lines_processed`归零，可能导致重复发送已经发过的内容）——**正常情况
不要手动改动这个文件**。

## 已知限制

- 只支持文本消息收发，图片/语音/文件协议里有定义（见 `weixin-bot-api.md`）但本脚本没实现。
- 单进程单bot_token，不支持多账号。
- 没有做 `outbox.jsonl` / `inbox.jsonl` 的自动清理/轮转，长期跑文件会一直增长，需要的话自己定期归档。
- 网络错误会自动重试（inbox长轮询报错等5秒重试），但不保证消息不丢——这是个人项目量级的实现，
  没做消息可靠性保证。
