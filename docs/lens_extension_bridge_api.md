# 浏览器扩展查Google Lens——SerpApi的免费备用路径

2026-08-17新增。背景：SerpApi免费层只有250次/月、不结转，很容易撞额度墙，付费又贵($25/月起)。
这套东西用你自己真实、日常在用的Chrome，免费、无限量地查Google Lens，作为SerpApi用完额度
之后的自动兜底。

## 为什么绕了这么大一圈才做出来

死磕过好几条路，都被拦住了，最后才发现真正能走通的是哪条：

1. **纯Playwright开一个全新浏览器** → 被Google识别成bot，跳验证码墙(`/sorry`)
2. **反检测库(rebrowser-playwright)+真实Chrome内核** → 一样被拦，说明不是"伪装得像不像"的问题
3. **Bright Data代理服务** → zone本身正常(普通Google搜索能查)，但`lens.google.com/uploadbyurl`
   这个特定端点被拒绝(`reject_element`)，说明SerpApi对这个端点做了额外的专门处理，不是随便一个
   代理服务就能顺带覆盖的
4. **CDP直连你真实的Edge/Chrome**(`--remote-debugging-port`) → Chrome 136+安全加固后，默认
   用户资料目录不允许命令行开调试端口(防止恶意程序借这个通道偷真实cookie/密码)；新版本的页面级
   开关(`chrome://inspect/#remote-debugging`)本身也不稳定/不是给外部程序用的，Playwright/
   Puppeteer目前都连不上它

真正的答案(参考OpenClaw项目的Chrome扩展模式，原理跟Claude in Chrome一样)：**不是"用什么工具"
的问题，是"这个标签页是不是从一开始就被外部自动化程序控制"的问题**。全新浏览器进程/CDP直连，
从启动那一刻就带着自动化标记；但一个**装在你真实Chrome里的扩展**，用`chrome.debugger`这个
标准扩展API去临时操作一个标签页，这是完全正常的浏览器行为(任何扩展都能这么干)，不会被打上
自动化标记。

## 架构

```
identify_model.mjs (getCandidates函数)
  │
  ├─ 先试 SerpApi (有key的话，更快)
  │    └─ 失败(比如429额度用完) ↓
  │
  └─ 降级到浏览器扩展查询
       │
       lens_extension_search.mjs (parseLensExtensionResult：把原始结果解析成candidates格式)
       │
       lens_extension_bridge.mjs (本地HTTP桥，127.0.0.1:17893)
       │  ↑↓ 轮询
       chrome_lens_extension/background.js (Manifest V3扩展，装在你真实Chrome里)
       │
       chrome.debugger API → 真实Chrome标签页 → lens.google.com
```

## 一次性安装(装完常驻，不用每次重装)

1. `chrome://extensions` → 打开"开发者模式" → "加载已解压的扩展程序" → 选
   `chrome_lens_extension/` 这个文件夹
2. 保持你的Chrome开着——查询的时候会**真实弹出一个新标签页**(前台可见，不是后台静默的)，
   跑完自动关掉。这是有意为之：早期版本用`active:false`(后台标签页)，结果发现浏览器不允许
   后台非激活标签页弹出文件选择对话框，`fileChooserOpened`事件死活不触发，改成前台标签页才通。

## 技术细节(踩过的坑)

- **不能直接`DOM.setFileInputFiles`怼一个querySelector找到的节点**：实测这么干files.length
  始终是0，静默不生效——大概率是Chrome对"扩展通过debugger权限设置任意本地文件路径"这件事本身
  做了安全限制(不然任何扩展都能读取用户磁盘任意文件，伪装成"上传"，是个明显的安全洞)。
- **正确做法**：`Page.setInterceptFileChooserDialog`开启拦截 → 真实点击"上传文件"触发原生
  文件选择框 → 响应`Page.fileChooserOpened`事件，用事件里带的`backendNodeId`去设置文件。
- **点击必须用`Input.dispatchMouseEvent`模拟真实鼠标事件，不能用`element.click()`合成点击**：
  合成点击不算"可信的用户手势"，浏览器不允许它触发原生文件选择对话框(防止网站自动弹文件框
  骗用户的标准安全限制)。
- **MV3 service worker会被系统随时终止**：用`chrome.alarms`代替`setInterval`保证轮询持续，
  但如果某次`handleTask`执行中途service worker被杀，`finally`里的清理逻辑(关标签页/解除
  debugger)可能跑不完，会在屏幕上留下残留的标签页——这个偶尔发生，手动关掉就行，不影响下次查询。
- **价格提取靠文本位置关联，不是精确DOM解析**：扩展只负责采集原始数据(整页文字+链接列表)，
  `lens_extension_search.mjs`里在Node端用"来源名字所在行、往后最多5行内找价格格式文字"这种
  启发式方法关联价格，不追求100%精确(Gemini后面会结合图片本身再判断一遍)，好处是DOM结构变了
  只用改Node端代码，不用重新加载扩展调试。

## 节流(2026-08-18补的)

批量跑`build_report.mjs`处理几十条listing时，之前是查完一条立刻紧接着查下一条，没有任何喘息——
不是真的并发(`CONCURRENCY=1`本身是串行的)，但"背靠背连续开关真实浏览器标签页+debugger attach"
这个动作本身对系统负担不小，实测直接把电脑跑卡了(简单的`tasklist`命令都要排队2分钟以上)。
现在`queryLensViaExtension`内部会自动节流：不管调用方隔多久调一次，两次真正开始查询之间强制
留够至少8秒间隔，不用调用方自己记得写sleep。超时时间也从60秒放宽到90秒，给系统更多缓冲空间。

## 严重bug：轮询没有防重入，实测把电脑跑到卡死(2026-08-18)

`pollOnce`最早的版本完全没有防重入——`chrome.alarms`每1.5秒触发一次，但`handleTask`单次
执行动辄几十秒(开标签页/等页面/等文件选择框/等结果渲染)。Node那边在拿到结果之前，
`pendingTask`一直是同一个task不变，所以只要上一次`handleTask`还没跑完，下一次alarm触发的
`pollOnce`又会GET到**同一个**task、又调一次`handleTask`——每次都新开一个标签页，而且因为
处理耗时远大于1.5秒的轮询间隔，会越攒越多，实测直接**无限弹出**新标签页，把电脑跑到卡死
(简单的`tasklist`命令都要排队2分钟以上)。

修复：加了`isBusy`这把锁，`handleTask`处理期间新的`pollOnce`直接跳过，不重入。

顺带修的一个相关bug：Node端`startBridge()`起的HTTP server之前没调`.unref()`，会一直占着
端口阻止Node进程自然退出——CLI测试脚本查完(哪怕超时失败)看着"结束"了，底层node.exe进程
其实一直没死、一直占着17893端口，下次一跑就撞`EADDRINUSE`。

## 已知限制

- 不支持并发查询(桥一次只处理一个任务，`identify_model.mjs`本身也是`CONCURRENCY=1`串行处理，
  暂时不冲突，但以后如果想提高并发度，这里要先改)
- 不支持传hint(消歧关键词)——纯图片搜索，SerpApi那边的`q`参数功能这条路径还没做
- 每次查询比SerpApi慢很多(要真实开一个浏览器标签页走完整流程，通常几十秒)
- 依赖你的真实Chrome处于打开状态，不适合完全无人值守的场景(比如你电脑关机的时候batch任务
  跑不了这条路，只能用SerpApi)
