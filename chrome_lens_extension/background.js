// background.js (Manifest V3 service worker)
//
// 轮询本地桥接服务器(lens_extension_bridge.mjs)要任务，干完活儿把结果传回去。
// 干活的方式：新建一个标签页，用chrome.debugger API临时附加上去，发CDP命令
// (设置文件到file input、等页面跳转、读取最终页面文字)，干完就分离debugger、关标签页。

const BRIDGE_URL = "http://127.0.0.1:17893";
const POLL_INTERVAL_MS = 1500;
const PROTOCOL_VERSION = "1.3";

// ---------- CDP辅助函数 ----------

function sendCommand(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// 等某个CDP事件触发一次(比如Page.loadEventFired)，带超时。
function waitForEvent(tabId, eventName, { timeoutMs = 20_000, filter } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.debugger.onEvent.removeListener(listener);
      reject(new Error(`等待事件 ${eventName} 超时(${timeoutMs}ms)`));
    }, timeoutMs);

    function listener(source, method, params) {
      if (source.tabId !== tabId || method !== eventName) return;
      if (filter && !filter(params)) return;
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(listener);
      resolve(params);
    }
    chrome.debugger.onEvent.addListener(listener);
  });
}

// ---------- 干活主逻辑 ----------

async function debugSnapshot(tabId) {
  // 出错时抓个现场：当前URL + 截图(base64 PNG)，方便事后诊断卡在哪一步，不用反复盲测
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const shot = await sendCommand(tabId, "Page.captureScreenshot", { format: "png" }).catch(() => null);
  return { url: tab?.url, screenshotBase64: shot?.data };
}

// Node那边超时放弃之后，这个任务对它来说已经死了——不该再花几十秒去开标签页、点鼠标、
// 等页面跳转，把Chrome搅得一团糟(之前吃过这个亏：几个"孤儿任务"在后台各跑各的，
// 屏幕上冒出一堆Lens标签页，看着像是新一次操作出的问题，其实是历史任务迟迟才收尾)。
// 在几个关键节点检查一下task.deadline，过期了就直接放弃，不再往下走。
function checkDeadline(task, stage) {
  if (task.deadline && Date.now() > task.deadline) {
    throw new Error(`任务已过期(阶段:${stage})，Node那边大概率已经放弃了，不再继续`);
  }
}

async function handleTask(task) {
  checkDeadline(task, "开始前");

  // active:true——之前用false(后台标签页)试过，怀疑浏览器不允许非激活的后台标签页弹出
  // 模态文件选择对话框，这可能就是fileChooserOpened事件死活不触发的原因。
  // 代价：每次查询会在屏幕上真实闪一下新标签页，不是完全静默的。
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  const tabId = tab.id;

  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    await sendCommand(tabId, "Page.enable");
    await sendCommand(tabId, "DOM.enable");

    // 导航到Lens上传页，等页面加载完
    const navPromise = waitForEvent(tabId, "Page.loadEventFired", { timeoutMs: 20_000 });
    await sendCommand(tabId, "Page.navigate", { url: "https://lens.google.com/upload" });
    await navPromise;
    checkDeadline(task, "页面加载后");
    await new Promise((r) => setTimeout(r, 1000)); // 给页面JS一点初始化时间

    // 标准做法：让调试器拦截原生的"选择文件"对话框，真的点一下"上传文件"这个链接触发它，
    // 弹窗事件(Page.fileChooserOpened)带着真正应该设置文件的那个节点(backendNodeId)，
    // 拿这个节点去设置文件，而不是自己用querySelector猜一个——之前这么干失败了
    // (三个input的files.length全是0，静默没生效，大概率是权限边界不允许这么干)。
    await sendCommand(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });

    const fileChooserPromise = waitForEvent(tabId, "Page.fileChooserOpened", { timeoutMs: 15_000 });

    // 找"上传文件"这个链接的屏幕坐标——用Runtime.evaluate的el.click()是合成事件，
    // 浏览器不认它能触发文件选择框(防止网站自动弹文件框骗用户的标准限制)。
    // 得用Input.dispatchMouseEvent模拟一次真实的、可信的鼠标点击才行。
    const rectResult = await sendCommand(tabId, "Runtime.evaluate", {
      expression:
        "(() => { const els = Array.from(document.querySelectorAll('a,button,span')); const el = els.find(e => e.textContent.trim() === '上传文件' || e.textContent.trim() === 'Upload a file'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
      returnByValue: true,
    });
    const point = rectResult.result.value;
    if (!point) {
      const snap = await debugSnapshot(tabId);
      throw Object.assign(new Error("没找到'上传文件'这个可点击元素"), { debug: snap });
    }

    let fileChooserEvent;
    try {
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1,
      });
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1,
      });
      fileChooserEvent = await fileChooserPromise;
    } catch (e) {
      const snap = await debugSnapshot(tabId);
      throw Object.assign(new Error(`点击后没等到文件选择框事件(点击坐标${point.x},${point.y}): ${e.message}`), {
        debug: snap,
      });
    }
    const nodeId = fileChooserEvent.backendNodeId;
    checkDeadline(task, "选完文件后");

    let navAfterUpload;
    try {
      navAfterUpload = waitForEvent(tabId, "Page.frameNavigated", {
        timeoutMs: 20_000,
        filter: (params) => params.frame.parentId === undefined,
      });
      await sendCommand(tabId, "DOM.setFileInputFiles", { files: [task.imagePath], backendNodeId: nodeId });
      await navAfterUpload;
    } catch (e) {
      const snap = await debugSnapshot(tabId);
      throw Object.assign(new Error(`选完文件后没等到跳转(backendNodeId=${nodeId}): ${e.message}`), {
        debug: snap,
      });
    }
    checkDeadline(task, "跳转后");
    await new Promise((r) => setTimeout(r, 4000)); // 结果是异步渲染的SPA内容，多等一下

    // 结构化提取：不只拿纯文字，把结果区域里每个链接的文字+href也单独拎出来。
    // 不知道这个页面确切的class名字(容易改版失效)，靠结构性事实(是不是<a>标签、
    // href是不是http开头)来抓，比硬编码class选择器更抗版本变化。
    const evalResult = await sendCommand(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const links = Array.from(document.querySelectorAll("a[href^='http']"))
          .filter((a) => a.innerText.trim().length > 0)
          .map((a) => ({ text: a.innerText.trim(), href: a.href }));
        return { bodyText: document.body.innerText, links };
      })()`,
      returnByValue: true,
    });
    const finalTab = await chrome.tabs.get(tabId);

    return { text: evalResult.result.value.bodyText, links: evalResult.result.value.links, url: finalTab.url };
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ---------- 轮询循环 ----------

// 严重bug修复(2026-08-18)：之前pollOnce完全没有防重入——alarm每1.5秒触发一次，
// 但handleTask单次执行动辄几十秒(开标签页/等页面/等文件选择框/等结果渲染)。
// Node那边在拿到结果之前，pendingTask一直是同一个task不变，所以只要上一次handleTask
// 还没跑完，下一次alarm触发的pollOnce又会GET到同一个task、又调一次handleTask——
// 每次都新开一个标签页，而且因为处理耗时远大于1.5秒的轮询间隔，会越攒越多，
// 实测直接"无限弹出"新标签页、把电脑跑到卡死。加一把锁，正在处理的时候直接跳过这次poll。
let isBusy = false;

async function pollOnce() {
  if (isBusy) return; // 上一个任务还没处理完，这次轮询直接跳过，不要重入
  try {
    const res = await fetch(`${BRIDGE_URL}/task`);
    if (res.status === 200) {
      const task = await res.json();
      isBusy = true;
      console.log("[poll] 领到任务:", task.imagePath);
      let payload;
      try {
        const result = await handleTask(task);
        console.log("[poll] 处理成功");
        payload = { id: task.id, result };
      } catch (e) {
        console.log("[poll] 处理失败:", e.message);
        payload = { id: task.id, error: e.message, debug: e.debug };
      } finally {
        isBusy = false;
      }
      await fetch(`${BRIDGE_URL}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
  } catch {
    // 桥没启动/连不上，静默跳过，下次轮询再试——桥不是一直开着的，这是正常状态，
    // 之前调试期间在这里打过详细日志，稳定下来后没必要每1.5秒刷一次屏
  }
}

// MV3 service worker会被浏览器随时终止/唤醒，用alarm代替setInterval保证持续轮询
chrome.alarms.create("poll", { periodInMinutes: POLL_INTERVAL_MS / 60_000 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "poll") pollOnce();
});
// 服务worker刚被唤醒时也立刻查一次，不用等第一个alarm周期
pollOnce();
