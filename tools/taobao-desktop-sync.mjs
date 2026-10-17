// 單號分類工具：淘寶桌面版訊息同步
// 讀取以 --remote-debugging-port 啟動的淘寶桌面版聊天頁，把集運站訊息送到後端 /api/inbox/messages。
//
// 用法：
//   node taobao-desktop-sync.mjs --set-secret   設定 INBOX_SECRET（存在本機，不進 git）
//   node taobao-desktop-sync.mjs --once         只同步一次並印出結果
//   node taobao-desktop-sync.mjs --orders       立即檢查一次淘寶與 1688 已發貨訂單，新單號加到件主名下
//   node taobao-desktop-sync.mjs                常駐，每隔 POLL_MS 同步一次

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BACKEND_URL = process.env.ORDER_TOOL_BACKEND_URL || "https://order-number-production.up.railway.app";
const DEBUG_PORT = Number(process.env.TAOBAO_DEBUG_PORT || 9333);
const TARGET_CONVERSATION = process.env.TAOBAO_TARGET_CONVERSATION || "捷豹國際集運站";
const CHAT_URL = process.env.TAOBAO_CHAT_URL
  || "https://market.m.taobao.com/app/im/chat-core/index.html?spm=tbpcclient.personal_index.sidebar.message#/";
const ENSURE_TASK_NAME = process.env.TAOBAO_ENSURE_TASK || "OrderNumberEnsureTaobao";
const RELAUNCH_COOLDOWN_MS = Number(process.env.TAOBAO_RELAUNCH_COOLDOWN_MS || 2 * 60 * 1000);
const POLL_MS = Number(process.env.TAOBAO_POLL_MS || 15000);
const ORDER_POLL_MS = Number(process.env.TAOBAO_ORDER_POLL_MS || 60 * 60 * 1000);
const ORDER_OWNER = process.env.TAOBAO_ORDER_OWNER || "鈞";
const EXCLUDED_SELLERS = new Set((process.env.TAOBAO_EXCLUDED_SELLERS || "jiejie1378918").split(",").map((s) => s.trim()).filter(Boolean));
const ORDER_RETRY_MS = 5 * 60 * 1000;
const CHROME_1688_PORT = Number(process.env.CHROME_1688_DEBUG_PORT || 9334);
const ORDER_1688_LIST_URL = "https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?page=1&pageSize=10";
const ORDER_1688_MAX_PAGES = 3;
const ORDER_MAX_PAGES = 5;
const ORDER_DETAIL_DELAY_MS = 1500;
const REMARK_MAX_CHARS = 20;
const MAX_REMEMBERED_IDS = 3000;
const MAX_LOG_BYTES = 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const APP_DIR = path.join(process.env.LOCALAPPDATA || process.env.HOME || ".", "order-number-taobao-sync");
const CONFIG_FILE = path.join(APP_DIR, "config.json");
const STATE_FILE = path.join(APP_DIR, "state.json");
const LOG_FILE = path.join(APP_DIR, "sync.log");

fs.mkdirSync(APP_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

let lastLogLine = "";
function log(text) {
  if (text === lastLogLine) return;
  lastLogLine = text;
  const line = `${new Date().toLocaleString("zh-TW", { hour12: false })} ${text}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
    }
    fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  } catch {
    // logging must never stop the sync loop
  }
}

function getSecret() {
  return (process.env.INBOX_SECRET || readJson(CONFIG_FILE, {}).inboxSecret || "").trim();
}

async function setSecret() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const secret = (await rl.question("請貼上單號分類工具的 INBOX_SECRET，按 Enter：")).trim();
  rl.close();
  if (!secret) {
    console.log("沒有輸入，未變更。");
    return;
  }
  writeJson(CONFIG_FILE, { ...readJson(CONFIG_FILE, {}), inboxSecret: secret });
  console.log(`已儲存到 ${CONFIG_FILE}`);
}

// Runs inside the chat page. Reads the structured message DOM of the active conversation.
const EXTRACT_EXPRESSION = `(() => {
  const NOISE = new Set(["已读", "未读", "已讀", "未讀"]);
  const clean = (text) => String(text || "").split("\\n").map((l) => l.trim()).filter((l) => l && !NOISE.has(l)).join("\\n");
  const activeEl = document.querySelector(".conversation-item.active .name");
  const messages = [...document.querySelectorAll(".message-item")].map((item) => ({
    sender: clean(item.querySelector(".nick")?.innerText),
    ts: (item.querySelector(".time")?.innerText || "").trim(),
    text: clean(item.querySelector(".content")?.innerText),
    self: item.classList.contains("self")
  })).filter((m) => m.ts && m.text);
  return JSON.stringify({ active: activeEl ? activeEl.innerText.trim() : null, messages });
})()`;

async function listDebugPages() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`, { signal: AbortSignal.timeout(5000) });
  return res.json();
}

async function inspectChatPage(page) {
  try {
    const raw = await evaluateInPage(page.webSocketDebuggerUrl, `JSON.stringify({
      convCount: document.querySelectorAll(".conversation-item").length,
      names: [...document.querySelectorAll(".conversation-item .name")].map((n) => n.innerText.trim()).filter(Boolean),
      active: document.querySelector(".conversation-item.active .name")?.innerText?.trim() || null,
      loggedOut: /您需要登录才能继续访问|請先登入/.test(document.body?.innerText || "")
    })`);
    return JSON.parse(raw);
  } catch {
    return { convCount: 0, names: [], active: null, loggedOut: true };
  }
}

async function closeDebugPage(page) {
  try {
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${page.id}`, { signal: AbortSignal.timeout(3000) });
  } catch {
    // ignore
  }
}

async function findChatPage() {
  let targets;
  try {
    targets = await listDebugPages();
  } catch {
    return { error: "TAOBAO_NOT_RUNNING" };
  }
  const candidates = targets.filter((t) => t.type === "page" && t.url.includes("/app/im/"));
  if (!candidates.length) return { error: "CHAT_NOT_OPEN" };

  let best = null;
  let bestScore = -1;
  for (const page of candidates) {
    const info = await inspectChatPage(page);
    // Prefer the real sidebar chat (has conversations) over the empty navigated clone.
    let score = info.convCount;
    if (info.names.includes(TARGET_CONVERSATION)) score += 100;
    if (info.active === TARGET_CONVERSATION) score += 50;
    if (page.url.includes("spm=")) score += 5;
    if (info.loggedOut || info.convCount === 0) score -= 1000;
    if (score > bestScore) {
      best = { page, info };
      bestScore = score;
    }
  }

  // Close empty/logged-out duplicate chat tabs so we don't keep picking the wrong one.
  for (const page of candidates) {
    if (page.id === best?.page?.id) continue;
    const info = await inspectChatPage(page);
    if (info.loggedOut || info.convCount === 0) await closeDebugPage(page);
  }

  if (!best || bestScore < 0) return { error: "CHAT_NOT_OPEN" };
  return { page: best.page, info: best.info };
}

let lastRelaunchAt = 0;

async function relaunchTaobaoDesktop() {
  const now = Date.now();
  if (now - lastRelaunchAt < RELAUNCH_COOLDOWN_MS) {
    log("淘寶桌面版剛重開過，稍後再試");
    return false;
  }
  lastRelaunchAt = now;
  log("淘寶桌面版已關閉或不是同步模式，正在自動重開…");
  try {
    await execFileAsync("schtasks.exe", ["/Run", "/TN", ENSURE_TASK_NAME], { windowsHide: true });
    log(`已觸發重開排程 ${ENSURE_TASK_NAME}`);
  } catch (error) {
    log(`自動重開失敗：${error.message}`);
    return false;
  }
  for (let i = 0; i < 50; i++) {
    await sleep(1000);
    try {
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
      log("淘寶桌面版已重新開啟（同步模式）");
      return true;
    } catch {
      // keep waiting
    }
  }
  log("自動重開逾時：請手動點桌面「淘寶同步」捷徑");
  return false;
}

function cdpCall(wsUrl, method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`DevTools 逾時：${method}`));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(msg.error.message || method));
      else resolve(msg.result);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("DevTools 連線失敗"));
    });
  });
}

async function openChatPageViaNavigate() {
  // Prefer bringing up the sidebar chat URL; avoid leaving behind empty "please login" clones.
  const targets = await listDebugPages();
  const candidate = targets.find((t) => t.type === "page" && t.url.includes("new-home"))
    || targets.find((t) => t.type === "page" && /^https?:/i.test(t.url) && !t.url.includes("/app/im/"))
    || targets.find((t) => t.type === "page" && t.url === "about:blank");
  if (!candidate?.webSocketDebuggerUrl) return false;
  await cdpCall(candidate.webSocketDebuggerUrl, "Page.navigate", { url: CHAT_URL });
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const found = await findChatPage();
    if (found.page && found.info?.convCount > 0) return true;
  }
  return false;
}

async function selectTargetConversation(wsUrl) {
  const expression = `(() => {
    const target = ${JSON.stringify(TARGET_CONVERSATION)};
    const items = [...document.querySelectorAll(".conversation-item")];
    const names = items.map((el) => (el.querySelector(".name")?.innerText || "").trim()).filter(Boolean);
    if (!names.length) return JSON.stringify({ ok: false, loading: true, names: [] });
    const hit = items.find((el) => (el.querySelector(".name")?.innerText || "").trim() === target);
    if (!hit) return JSON.stringify({ ok: false, loading: false, names: names.slice(0, 30) });
    const clickable = hit.querySelector(".name") || hit;
    clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    clickable.click();
    const active = document.querySelector(".conversation-item.active .name")?.innerText?.trim() || null;
    const shopTitle = document.querySelector(".shopName__f8d760, .ww_message .name, .shopInfo .name")?.innerText?.trim() || "";
    return JSON.stringify({ active, shopTitle, loading: false, clicked: true });
  })()`;
  for (let attempt = 0; attempt < 20; attempt++) {
    const raw = await evaluateInPage(wsUrl, expression);
    const result = JSON.parse(raw);
    if (result.active === TARGET_CONVERSATION) return true;
    if (result.clicked) {
      await sleep(1000);
      const snap = JSON.parse(await evaluateInPage(wsUrl, EXTRACT_EXPRESSION));
      if (snap.active === TARGET_CONVERSATION) return true;
      if (snap.messages?.length && (result.shopTitle || "").includes(TARGET_CONVERSATION)) return true;
    }
    await sleep(result.loading ? 2000 : 1500);
  }
  return false;
}

async function clickImmediateLogin() {
  let targets;
  try {
    targets = await listDebugPages();
  } catch {
    return false;
  }
  const loginPages = targets.filter((t) => t.type === "page" && (
    t.url.includes("loginPop") || /登陆|登錄|登录/i.test(t.title || "")
  ));
  if (!loginPages.length) return false;

  // Only click when the button is actually visible (ignore stale/hidden loginPop pages).
  const expression = `(() => {
    const btn = document.querySelector(".login-btn-in")
      || [...document.querySelectorAll("button,a,div,span")].find((el) => /立即登[录錄入]/.test((el.innerText || "").trim()));
    if (!btn) return JSON.stringify({ ok: false, reason: "no-btn" });
    const rect = btn.getBoundingClientRect();
    const style = getComputedStyle(btn);
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    if (!visible) return JSON.stringify({ ok: false, reason: "hidden" });
    btn.click();
    return JSON.stringify({ ok: true, text: (btn.innerText || "").trim() });
  })()`;

  let clicked = false;
  for (const page of loginPages) {
    try {
      const raw = await evaluateInPage(page.webSocketDebuggerUrl, expression);
      const result = JSON.parse(raw);
      if (result.ok) {
        log(`已自動點「${result.text || "立即登入"}」`);
        clicked = true;
        break;
      }
    } catch {
      // popup may already be closing
    }
  }
  if (!clicked) return false;

  // After login the app may briefly restart; wait for debug port and for the visible button to disappear.
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
      const pages = await listDebugPages();
      const pop = pages.find((t) => t.type === "page" && t.url.includes("loginPop"));
      if (!pop) return true;
      const state = JSON.parse(await evaluateInPage(pop.webSocketDebuggerUrl, `JSON.stringify({
        visible: (() => {
          const btn = document.querySelector(".login-btn-in");
          if (!btn) return false;
          const rect = btn.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })()
      })`));
      if (!state.visible) return true;
    } catch {
      // port down while app settles after login
    }
  }
  return true;
}

async function waitForLoginPopup(maxSeconds = 15) {
  for (let i = 0; i < maxSeconds; i++) {
    try {
      const pages = await listDebugPages();
      for (const page of pages.filter((t) => t.type === "page" && t.url.includes("loginPop"))) {
        const raw = await evaluateInPage(page.webSocketDebuggerUrl, `JSON.stringify({
          visible: (() => {
            const btn = document.querySelector(".login-btn-in");
            if (!btn) return false;
            const rect = btn.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          })()
        })`);
        if (JSON.parse(raw).visible) return true;
      }
    } catch {
      // not ready
    }
    await sleep(1000);
  }
  return false;
}

async function ensureChatReady() {
  let found = await findChatPage();

  // Already on a usable chat page — never touch the login popup again.
  if (found.page && found.info?.convCount > 0) {
    if (found.info.active === TARGET_CONVERSATION) return found;
    try {
      const snapshot = JSON.parse(await evaluateInPage(found.page.webSocketDebuggerUrl, EXTRACT_EXPRESSION));
      if (snapshot.active === TARGET_CONVERSATION) return found;
      log(`對話不是「${TARGET_CONVERSATION}」，正在自動切換…`);
      if (await selectTargetConversation(found.page.webSocketDebuggerUrl)) {
        log(`已切到「${TARGET_CONVERSATION}」`);
        return await findChatPage();
      }
      log(`自動切換對話失敗，目前請手動點「${TARGET_CONVERSATION}」`);
    } catch (error) {
      log(`檢查對話失敗：${error.message}`);
    }
    return found;
  }

  if (found.error === "TAOBAO_NOT_RUNNING") {
    if (!(await relaunchTaobaoDesktop())) return found;
    await sleep(4000);
    // Fresh start often shows 「立即登录」 first.
    await waitForLoginPopup(12);
    try {
      await clickImmediateLogin();
    } catch (error) {
      log(`自動登入點擊失敗：${error.message}`);
    }
    found = await findChatPage();
  }

  // Chat missing but app is up — login popup may be blocking; click once, then open messages.
  if (found.error === "CHAT_NOT_OPEN" || (found.page && !(found.info?.convCount > 0))) {
    await waitForLoginPopup(5);
    try {
      await clickImmediateLogin();
    } catch (error) {
      log(`自動登入點擊失敗：${error.message}`);
    }
    found = await findChatPage();
  }

  if (found.error === "TAOBAO_NOT_RUNNING") {
    if (await relaunchTaobaoDesktop()) {
      await sleep(4000);
      await waitForLoginPopup(12);
      await clickImmediateLogin();
      found = await findChatPage();
    }
  }

  if (found.error === "CHAT_NOT_OPEN") {
    log("聊天頁未開啟，正在自動打開消息…");
    try {
      if (await openChatPageViaNavigate()) {
        found = await findChatPage();
      } else {
        log("自動打開聊天頁失敗，請在淘寶點「消息」");
        return found;
      }
    } catch (error) {
      log(`自動打開聊天頁失敗：${error.message}`);
      return found;
    }
  }
  if (!found.page) return found;

  try {
    if (found.info?.active === TARGET_CONVERSATION) return found;
    const snapshot = JSON.parse(await evaluateInPage(found.page.webSocketDebuggerUrl, EXTRACT_EXPRESSION));
    if (snapshot.active === TARGET_CONVERSATION) return found;
    log(`對話不是「${TARGET_CONVERSATION}」，正在自動切換…`);
    if (await selectTargetConversation(found.page.webSocketDebuggerUrl)) {
      log(`已切到「${TARGET_CONVERSATION}」`);
      return await findChatPage();
    }
    log(`自動切換對話失敗，目前請手動點「${TARGET_CONVERSATION}」`);
  } catch (error) {
    log(`檢查對話失敗：${error.message}`);
  }
  return found;
}

function evaluateInPage(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("DevTools 逾時"));
    }, 30000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error || msg.result?.exceptionDetails) reject(new Error("頁面讀取失敗"));
      else resolve(msg.result.result.value);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("DevTools 連線失敗"));
    });
  });
}

async function postToBackend(endpoint, body, secret) {
  const res = await fetch(`${BACKEND_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, code: json.error });
  return json;
}

function postMessages(messages, secret) {
  return postToBackend("/api/inbox/messages", { messages }, secret);
}

// Calls Taobao's own mtop API from inside a logged-in Taobao page, so the app's cookies and signing are reused.
async function mtopRequest(wsUrl, options) {
  const expression = `new Promise((resolve) => {
    if (!window.lib || !window.lib.mtop) return resolve(JSON.stringify({ err: "NO_MTOP" }));
    window.lib.mtop.request(${JSON.stringify(options)})
      .then((r) => resolve(JSON.stringify({ ok: r })))
      .catch((e) => resolve(JSON.stringify({ err: e })));
  })`;
  const result = JSON.parse(await evaluateInPage(wsUrl, expression));
  if (result.err) {
    const ret = Array.isArray(result.err?.ret) ? result.err.ret.join(",") : String(result.err);
    throw new Error(`淘寶介面錯誤 ${options.api}：${ret}`);
  }
  return result.ok;
}

async function fetchShippedOrders(wsUrl) {
  const orders = [];
  for (let page = 1; page <= ORDER_MAX_PAGES; page++) {
    const res = await mtopRequest(wsUrl, {
      api: "mtop.taobao.order.queryboughtlistv2",
      v: "1.0",
      ecode: 1,
      type: "GET",
      timeout: 15000,
      data: { tabCode: "waitConfirm", page, OrderType: "OrderList", appName: "tborder", appVersion: "3.0", condition: JSON.stringify({ version: "1.0.0" }) }
    });
    const result = JSON.parse(res.data.result);
    (result.mainOrders || []).forEach((order) => {
      orders.push({
        id: String(order.id),
        seller: order.seller?.nick || "",
        titles: (order.subOrders || []).map((sub) => sub.itemInfo?.title || "").filter(Boolean)
      });
    });
    if (page >= Number(result.page?.totalPage || 1)) break;
  }
  return orders;
}

async function queryLogistics(wsUrl, params) {
  const res = await mtopRequest(wsUrl, {
    api: "mtop.taobao.logistics.detailorlist.query",
    v: "1.0",
    timeout: 15000,
    ttid: "#t#ip##_h5_web_default",
    data: params
  });
  return res.data || {};
}

// One order may ship in several packages; Taobao then returns a package list instead of a single trace.
async function getTrackingNumbers(wsUrl, orderId) {
  const detail = await queryLogistics(wsUrl, { orderId });
  const blocks = Object.values(detail.data || {});
  if (detail.endpoint?.page !== "logisticsPackageList") {
    const company = blocks.find((block) => block?.tag === "popupBodyCompony");
    const mailNo = company?.fields?.mailNo;
    return mailNo ? [mailNo] : [];
  }

  const numbers = [];
  for (const block of blocks.filter((b) => b?.tag === "pakcage" || b?.tag === "package")) {
    const query = String(block.fields?.rightBtnUrl || "").split("?")[1] || "";
    const params = Object.fromEntries(new URLSearchParams(query));
    if (params.mailNo) {
      numbers.push(params.mailNo);
      continue;
    }
    if (!params.orderId) continue;
    await sleep(ORDER_DETAIL_DELAY_MS);
    const sub = await queryLogistics(wsUrl, { orderId: params.orderId, logisticsOrderId: params.logisticsOrderId });
    const company = Object.values(sub.data || {}).find((b) => b?.tag === "popupBodyCompony");
    if (company?.fields?.mailNo) numbers.push(company.fields.mailNo);
  }
  return [...new Set(numbers)];
}

function shortRemark(titles) {
  return titles.join("、").replace(/\s+/g, " ").trim().slice(0, REMARK_MAX_CHARS);
}

async function syncOrders() {
  const secret = getSecret();
  if (!secret) return;
  const found = await findChatPage();
  if (found.error) {
    log("略過訂單檢查：淘寶桌面版沒有開或沒登入");
    return false;
  }
  const wsUrl = found.page.webSocketDebuggerUrl;

  const orders = (await fetchShippedOrders(wsUrl))
    .filter((order) => !seenOrders.has(order.id) && !EXCLUDED_SELLERS.has(order.seller));
  if (!orders.length) {
    log("淘寶訂單檢查完成｜沒有新發貨的訂單");
    return true;
  }

  const parcels = [];
  const resolvedOrderIds = [];
  for (const order of orders) {
    await sleep(ORDER_DETAIL_DELAY_MS);
    try {
      const numbers = await getTrackingNumbers(wsUrl, order.id);
      // Orders without a tracking number are virtual goods or "no logistics needed"; never revisit them.
      numbers.forEach((tracking) => parcels.push({ tracking, remark: shortRemark(order.titles), order_id: order.id }));
      resolvedOrderIds.push(order.id);
    } catch (error) {
      log(`查詢訂單 ${order.id} 物流失敗：${error.message}`);
    }
  }

  return submitParcels("淘寶", parcels, resolvedOrderIds, secret);
}

async function submitParcels(label, parcels, resolvedOrderIds, secret) {
  if (parcels.length) {
    try {
      const result = await postToBackend("/api/inbox/orders", { owner: ORDER_OWNER, orders: parcels }, secret);
      log(`${label}訂單檢查完成｜新增單號 ${result.added || 0} 筆，已存在 ${result.existing || 0} 筆`);
    } catch (error) {
      if (error.code === "OWNER_NOT_FOUND") log(`單號分類工具裡找不到件主「${ORDER_OWNER}」`);
      else if (error.status === 401) log("密鑰錯誤：請執行 node taobao-desktop-sync.mjs --set-secret");
      else log(`${label}送出訂單失敗：${error.message}${error.cause ? ` (${error.cause.code || error.cause.message})` : ""}`);
      return false;
    }
  } else {
    log(`${label}訂單檢查完成｜${resolvedOrderIds.length} 筆新訂單都沒有快遞單號`);
  }

  resolvedOrderIds.forEach((id) => seenOrders.add(id));
  saveState();
  return true;
}

// 1688 runs in a dedicated Chrome profile (Chrome, unlike the Taobao app, can open background tabs over CDP).
class ChromeSession {
  static async open(url) {
    const version = await (await fetch(`http://127.0.0.1:${CHROME_1688_PORT}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
    const session = new ChromeSession(new WebSocket(version.webSocketDebuggerUrl));
    await new Promise((resolve, reject) => {
      session.ws.addEventListener("open", resolve, { once: true });
      session.ws.addEventListener("error", () => reject(new Error("Chrome 連線失敗")), { once: true });
    });
    const created = await session.send("Target.createTarget", { url, background: true });
    session.targetId = created.targetId;
    session.sessionId = (await session.send("Target.attachToTarget", { targetId: session.targetId, flatten: true })).sessionId;
    return session;
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      const handler = msg.id && this.pending.get(msg.id);
      if (!handler) return;
      this.pending.delete(msg.id);
      if (msg.error) handler.reject(new Error(msg.error.message));
      else handler.resolve(msg.result);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome 逾時：${method}`));
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.sessionId);
    if (result.exceptionDetails) throw new Error("1688 頁面執行失敗");
    return result.result.value;
  }

  async close() {
    try {
      if (this.targetId) await this.send("Target.closeTarget", { targetId: this.targetId });
    } catch {
      // tab may already be gone
    }
    this.ws.close();
  }
}

async function mtop1688(session, api, data) {
  const raw = await session.evaluate(`new Promise((resolve) => {
    if (!window.lib || !window.lib.mtop) return resolve(JSON.stringify({ err: "NO_MTOP" }));
    window.lib.mtop.request({ api: ${JSON.stringify(api)}, v: "1.0", ecode: 1, type: "GET", dataType: "json", valueType: "string", timeout: 15000, data: ${JSON.stringify(data)} })
      .then((r) => resolve(JSON.stringify({ ok: r })))
      .catch((e) => resolve(JSON.stringify({ err: e })));
  })`);
  const result = JSON.parse(raw);
  if (result.err) {
    const ret = Array.isArray(result.err?.ret) ? result.err.ret.join(",") : JSON.stringify(result.err);
    throw new Error(`1688 介面錯誤 ${api}：${ret}`);
  }
  return result.ok;
}

async function waitFor1688Page(session) {
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const state = JSON.parse(await session.evaluate(`JSON.stringify({ host: location.host, ready: !!(window.lib && window.lib.mtop) })`));
    if (/login/i.test(state.host)) return "LOGGED_OUT";
    if (state.ready) return "READY";
  }
  return "TIMEOUT";
}

async function sync1688Orders() {
  const secret = getSecret();
  if (!secret) return;

  let session;
  try {
    session = await ChromeSession.open(ORDER_1688_LIST_URL);
  } catch {
    log("略過 1688：同步專用 Chrome 沒有開（點桌面「淘寶同步」捷徑或重新登入 Windows）");
    return false;
  }

  try {
    const pageState = await waitFor1688Page(session);
    if (pageState === "LOGGED_OUT") {
      log("1688 已登出：請在同步專用 Chrome 重新登入 1688");
      return false;
    }
    if (pageState !== "READY") {
      log("1688 訂單頁載入逾時");
      return false;
    }

    const orders = [];
    for (let page = 1; page <= ORDER_1688_MAX_PAGES; page++) {
      const res = await mtop1688(session, "mtop.1688.trading.dataline.service", {
        serviceId: "OrderListDataLineService.buyerOrderList",
        param: JSON.stringify({ page, pageSize: 20 })
      });
      const payload = res.data?.data?.result ?? res.data?.result;
      const list = typeof payload === "string" ? JSON.parse(payload) : payload;
      const rows = list?.data?.data || [];
      rows.forEach((row) => orders.push({
        id: `1688:${row.idStr || row.id}`,
        orderId: String(row.idStr || row.id),
        status: row.status,
        titles: (row.orderEntries || []).map((entry) => entry.productName || "").filter(Boolean)
      }));
      if (page >= Number(list?.data?.pages || 1)) break;
      await sleep(ORDER_DETAIL_DELAY_MS);
    }

    const fresh = orders.filter((order) => order.status === "waitbuyerreceive" && !seenOrders.has(order.id));
    if (!fresh.length) {
      log("1688 訂單檢查完成｜沒有新發貨的訂單");
      return true;
    }

    const trace = await mtop1688(session, "mtop.1688.MtopLgtTraceService.queryTrace", { orderIds: fresh.map((o) => o.orderId).join(",") });
    const traceResult = typeof trace.data?.result === "string" ? JSON.parse(trace.data.result) : trace.data?.result;
    const traceByOrder = new Map((traceResult || []).map((item) => [String(item.orderId), item.trace || []]));
    const parcels = [];
    const resolved = [];
    // Unlike Taobao, 1688 has no virtual goods here: an order without a number is just not traced yet, so retry later.
    fresh.forEach((order) => {
      const numbers = [...new Set((traceByOrder.get(order.orderId) || []).map((t) => t.mailNo).filter(Boolean))];
      if (!numbers.length) return;
      numbers.forEach((tracking) => parcels.push({ tracking, remark: shortRemark(order.titles), order_id: order.orderId }));
      resolved.push(order.id);
    });
    return submitParcels("1688 ", parcels, resolved, secret);
  } finally {
    await session.close();
  }
}

async function maybeSyncOrders() {
  if (Date.now() - lastOrderCheck < ORDER_POLL_MS) return;
  let ok = true;
  for (const job of [syncOrders, sync1688Orders]) {
    try {
      if ((await job()) === false) ok = false;
    } catch (error) {
      ok = false;
      log(`訂單檢查錯誤：${error.message}`);
    }
  }
  lastOrderCheck = ok ? Date.now() : Date.now() - ORDER_POLL_MS + ORDER_RETRY_MS;
  saveState();
}

const state = readJson(STATE_FILE, {});
let sentIds = new Set(state.sentIds || []);
let seenOrders = new Set(state.seenOrders || []);
let lastOrderCheck = Number(state.lastOrderCheck || 0);

function saveState() {
  sentIds = new Set([...sentIds].slice(-MAX_REMEMBERED_IDS));
  seenOrders = new Set([...seenOrders].slice(-MAX_REMEMBERED_IDS));
  writeJson(STATE_FILE, { sentIds: [...sentIds], seenOrders: [...seenOrders], lastOrderCheck });
}

function rememberSent(ids) {
  ids.forEach((id) => sentIds.add(id));
  saveState();
}

async function syncOnce() {
  const secret = getSecret();
  if (!secret) {
    log("尚未設定密鑰：請執行 node taobao-desktop-sync.mjs --set-secret");
    return;
  }

  const found = await ensureChatReady();
  if (found.error === "TAOBAO_NOT_RUNNING") {
    log("淘寶桌面版沒有以同步模式執行（找不到除錯埠）");
    return;
  }
  if (found.error === "CHAT_NOT_OPEN" || !found.page) {
    log("淘寶桌面版沒有開啟聊天頁（可能被登出，或還沒點開「消息」）");
    return;
  }

  const snapshot = JSON.parse(await evaluateInPage(found.page.webSocketDebuggerUrl, EXTRACT_EXPRESSION));
  if (snapshot.active !== TARGET_CONVERSATION) {
    log(`目前開的對話是「${snapshot.active || "無"}」，請切回「${TARGET_CONVERSATION}」`);
    return;
  }

  const messages = snapshot.messages.map((m) => ({ id: `${m.ts}|${m.text}`, ts: m.ts, sender: m.sender, self: m.self, text: m.text }));
  const unsent = messages.filter((m) => !sentIds.has(m.id));
  if (!unsent.length) {
    log(`運作中｜畫面 ${messages.length} 則，沒有新訊息`);
    return;
  }

  try {
    const result = await postMessages(unsent, secret);
    rememberSent(unsent.map((m) => m.id));
    log(`送出 ${unsent.length} 則｜入庫 ${result.inbound || 0}、待出貨 ${result.quotes || 0}、台灣單號 ${result.taiwan || 0}`);
  } catch (error) {
    if (error.status === 401) log("密鑰錯誤：請執行 node taobao-desktop-sync.mjs --set-secret");
    else log(`送出失敗：${error.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--set-secret")) return setSecret();
  if (args.includes("--once")) return syncOnce();
  if (args.includes("--ensure")) {
    const found = await ensureChatReady();
    console.log(JSON.stringify(found.error ? found : { ok: true, url: found.page.url }));
    return;
  }
  if (args.includes("--orders")) {
    await syncOrders();
    await sync1688Orders();
    return;
  }

  log(`常駐同步啟動（聊天每 ${POLL_MS / 1000} 秒、訂單每 ${ORDER_POLL_MS / 60000} 分鐘；淘寶關掉會自動重開並進捷豹對話）`);
  for (;;) {
    try {
      await syncOnce();
    } catch (error) {
      log(`同步錯誤：${error.message}`);
    }
    await maybeSyncOrders();
    await sleep(POLL_MS);
  }
}

main();
