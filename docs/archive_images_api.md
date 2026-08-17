# 图片本地归档脚本

脚本：`~/IdeaProjects/scooter-dm-helper/archive_images.mjs`

## 为什么需要这个

小红书图床的图片URL是有时效的——实测隔几个小时到一天，同一批listing的图片URL就开始大批量
403。而且小红书搜索结果排序实时变化，同一个关键词重新搜一次不保证能再搜到同一条帖子，一旧
图片URL失效基本就没有简单的补救办法(唯一办法是这条帖子恰好又被搜到，或者用还没过期的
`xsec_token`走detail模式重新抓——但`xsec_token`本身也是有时效的凭证)。

解决思路很简单：**图片URL最新鲜的时候(刚爬完那一刻)立刻下载存本地**，以后这条帖子的图片
就再也不用碰小红书的服务器了。

## 用法

```bash
cd ~/IdeaProjects/scooter-dm-helper
node consolidate_notes.mjs   # 先合并去重，确保all_contents.jsonl是最新的
node archive_images.mjs      # 再紧接着跑这个，图片URL最新鲜的时候归档
```

**这两步要挨着跑，中间别拖太久**——`consolidate_notes.mjs`生成的`all_contents.jsonl`里的图片
URL来自MediaCrawler最近一次抓取，隔的时间越久，`archive_images.mjs`能成功下载到的比例越低。

## 存储结构

```
images/<note_id>/0.jpg
images/<note_id>/1.jpg
...
```

按`image_list`原始顺序编号(跟`identify_model.mjs`的`noteId`归档用的是同一套路径规则，两边
自动对得上，不用手动同步)。

## 行为细节

- **已存档的note_id会跳过**，不重复下载——判断标准是本地目录下`.jpg`文件数 >= `image_list`
  里的图片数。如果之前只下载成功了一部分(比如中途网络断了)，这个判断会误判成"已存档"而跳过，
  少下载的那几张就一直缺着——目前没做"补齐残缺归档"的逻辑，发现这种情况得手动删掉那个
  note_id的目录再重跑。
- 单张图下载失败会打印错误但不影响其它图/其它笔记，不会让整个脚本中断。
- 并发度3(`CONCURRENCY`常量)，跟`build_report.mjs`当前配置一致的克制程度。
- 没有图片的笔记(`image_list`为空)会跳过，不报错。

## 已知坑

- 对**已经过期**的图片URL无能为力——这个脚本只能保证"以后不再过期"，救不回已经403掉的历史
  数据。实测第一次全量跑的时候，56条笔记里有一部分(主要是较早的08-14批次、且没有在后续重新
  抓取里被搜索结果收录的)已经403，永久拿不到图了。
- 不会自动清理/去重本地图片，同一张图如果因为MediaCrawler多次抓取产生了不同note_id(理论上
  不会，note_id是帖子唯一标识，但如果小红书哪天改了ID规则要注意)，可能会有冗余存储，目前
  没做这个层面的处理。
