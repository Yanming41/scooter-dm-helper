# 小红书搜索爬虫 API 文档

底层是 [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler)，装在 `~/IdeaProjects/MediaCrawler`。
本文档只记录**我们实际怎么调用它**，不是 MediaCrawler 的完整说明书。

## 完整流水线顺序(每次要抓新数据/巡逻检查更新时都按这个顺序跑)

```bash
cd ~/IdeaProjects/MediaCrawler
uv run main.py --platform xhs --lt qrcode --type search   # 1. 抓取(搜索)

cd ~/IdeaProjects/scooter-dm-helper
node consolidate_notes.mjs   # 2. 合并去重所有日期的抓取结果
node archive_images.mjs      # 3. 立刻把图片下载存本地——图片URL有时效，隔几小时到一天就会403，
                              #    必须在URL最新鲜的这一刻就存下来，不能拖到后面识图那一步再下载
node build_report.mjs        # 4. 识图+算旧新比例
```

**第3步(`archive_images.mjs`)不能省略、也不能拖后**——这是踩过好几次坑才定下来的顺序：
之前的设计是"要用到图片的时候再实时下载"，结果同一批listing隔了一天再处理，图片URL已经大批量403了，
而且小红书的搜索结果排序是实时变化的，同一个关键词重新搜一次，不保证还能搜到同一条帖子(排到后面/掉出
结果页都有可能)——一旦图片没能在第一时间存下来，这条listing的图片数据基本就永久丢失了，没有"重新爬
一次"这种简单的补救办法。

## 调用方式

命令行工具，非常驻，跑一次退出：

```bash
cd ~/IdeaProjects/MediaCrawler
uv run main.py --platform xhs --lt qrcode --type search
```

| 参数 | 值 | 说明 |
|---|---|---|
| `--platform` | `xhs` | 固定 |
| `--lt` | `qrcode` | 登录方式，扫码 |
| `--type` | `search` | 搜索模式（另有 `detail`/`creator`，本项目没用到） |

首次运行需要扫码登录，登录态会缓存在 `MediaCrawler/browser_data/`（`SAVE_LOGIN_STATE=True`），
之后重复运行大概率不用再扫码，除非 cookie 过期或被风控刷掉。

## 关键配置项

配置文件：`MediaCrawler/config/base_config.py` 和 `config/xhs_config.py`。改完直接生效，无需重新安装。

| 文件 | 配置项 | 当前值 | 说明 |
|---|---|---|---|
| base_config.py | `KEYWORDS` | 按需修改 | 多个关键词用英文逗号分隔，会依次搜索 |
| base_config.py | `ENABLE_CDP_MODE` | `False` | 用独立 Playwright chromium，不接管真实Chrome |
| base_config.py | `HEADLESS` | `False` | 会弹出浏览器窗口（登录/滑块验证需要肉眼可见） |
| base_config.py | `CRAWLER_MAX_NOTES_COUNT` | `15` | 每个关键词最多抓多少篇笔记 |
| base_config.py | `ENABLE_GET_COMMENTS` | `True` | 是否连带抓评论 |
| base_config.py | `SAVE_DATA_OPTION` | `jsonl` | 输出格式 |
| xhs_config.py | `SORT_TYPE` | `time_descending` | 按最新排序（找二手listing用这个，而不是默认的热度排序） |

## 输出文件

路径：`MediaCrawler/data/xhs/jsonl/`，文件名按当天日期生成，**每次运行会追加/新建当天的文件，不同日期之间同一条
帖子会重复出现，不会自动去重**。

每次重新抓完，跑一遍 `node consolidate_notes.mjs`（在 `scooter-dm-helper` 项目里），把所有日期的文件按
`note_id`/`comment_id` 合并去重，生成持久的 `all_contents.jsonl` / `all_comments.jsonl`——下游脚本
(`build_report.mjs`、`identify_model.mjs` 的CLI测试)都读这两份文件，不再硬编码某一天的日期。

### `search_contents_<日期>.jsonl` —— 笔记正文

一行一条笔记，JSON字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `note_id` | string | 笔记唯一ID，去重用这个 |
| `type` | string | 笔记类型（图文/视频） |
| `title` | string | 标题 |
| `desc` | string | 正文全文（价格、地点等关键信息都在这里，需要自己正则/人工提取，**不要只信自动提取的价格**，见下方教训） |
| `video_url` | string | 视频链接（图文笔记为空） |
| `time` | int | 发布时间，**毫秒级时间戳** |
| `last_update_time` | int | 最后编辑时间 |
| `nickname` | string | 作者昵称 |
| `creator_hash` | string | 作者ID的哈希 |
| `liked_count` / `collected_count` / `comment_count` / `share_count` | string | 互动数据 |
| `image_list` | array | 图片信息 |
| `tag_list` | array | 话题标签 |
| `note_url` | string | **笔记完整链接，带 `xsec_token`（有时效性，尽快用）** |
| `source_keyword` | string | 这条笔记是搜哪个关键词搜出来的 |

### `search_comments_<日期>.jsonl` —— 评论

| 字段 | 类型 | 说明 |
|---|---|---|
| `comment_id` | string | 评论ID |
| `note_id` | string | 对应哪条笔记 |
| `content` | string | 评论内容 |
| `create_time` | int | 发布时间 |
| `nickname` | string | 评论者昵称 |
| `like_count` | string | 点赞数 |
| `parent_comment_id` | string | 二级评论对应的父评论（一级评论此字段为空） |
| `sub_comment_count` | string | 子评论数 |
| `pictures` | array | 评论配图 |

## 已知坑

- **价格提取别用简单正则一把梭**：`desc` 里价格写法五花八门（`$200` / `200刀` / 裸写`200` / emoji代替"刀"字比如`200🔪` / 欧元`270€`），
  简单正则会漏很多，之前漏过至少6条真实listing。建议人工过一遍，或者写更完整的多模式匹配 + 人工抽查。
- 同一关键词组的多次搜索结果会有大量重叠，下游一定要按 `note_id` 去重再处理(`consolidate_notes.mjs`已经做了)。
- `note_url` 里的 `xsec_token` 是有时效的访问凭证，抓完尽快消费，别攒着几天后再点开。
- **`image_list`里的图片URL同样有时效**(踩过好几次，隔一天基本就403了)，这个问题不是"抓紧点开"能
  完全解决的——已经改成用`archive_images.mjs`在抓完的第一时间把图片存本地，从根上解决，见上面的
  流水线顺序。
