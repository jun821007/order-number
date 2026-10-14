// 單號分類工具：淘寶桌面版訊息同步
// 讀取以 --remote-debugging-port 啟動的淘寶桌面版聊天頁，把集運站訊息送到後端 /api/inbox/messages。
//
// 用法：
//   node taobao-desktop-sync.mjs --set-secret   設定 INBOX_SECRET（存在本機，不進 git）
//   node taobao-desktop-sync.mjs --once         只同步一次並印出結果
//   node taobao-desktop-sync.mjs --orders       立即檢查一次淘寶已發貨訂單，新單號加到件主名下
//   node taobao-desktop-sync.mjs                常駐，每隔 POLL_MS 同步一次

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

const BACKEND_URL = process.env.ORDER_TOOL_BACKEND_URL || "https://order-number-production.up.railway.app";
const DEBUG_PORT = Number(process.env.TAOBAO_DEBUG_PORT || 9333);
const TARGET_CONVERSATION = process.env.TAOBAO_TARGET_CONVERSATION || "捷豹國際集運站";
const POLL_MS = Number(process.env.TAOBAO_POLL_MS || 15000);
const ORDER_POLL_MS = Number(process.env.TAOBAO_ORDER_POLL_MS || 60 * 60 * 1000);
const ORDER_OWNER = process.env.TAOBAO_ORDER_OWNER || "鈞";
const EXCLUDED_SELLERS = new Set((process.env.TAOBAO_EXCLUDED_SELLERS || "jiejie1378918").split(",").map((s) => s.trim()).filter(Boolean));
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

async function findChatPage() {
  let targets;
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`, { signal: AbortSignal.timeout(5000) });
    targets = await res.json();
  } catch {
    return { error: "TAOBAO_NOT_RUNNING" };
  }
  const page = targets.find((t) => t.type === "page" && t.url.includes("/app/im/"));
  return page ? { page } : { error: "CHAT_NOT_OPEN" };
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
    return;
  }
  const wsUrl = found.page.webSocketDebuggerUrl;

  const orders = (await fetchShippedOrders(wsUrl))
    .filter((order) => !seenOrders.has(order.id) && !EXCLUDED_SELLERS.has(order.seller));
  if (!orders.length) {
    log("訂單檢查完成｜沒有新發貨的訂單");
    return;
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

  if (parcels.length) {
    try {
      const result = await postToBackend("/api/inbox/orders", { owner: ORDER_OWNER, orders: parcels }, secret);
      log(`訂單檢查完成｜新增單號 ${result.added || 0} 筆，已存在 ${result.existing || 0} 筆`);
    } catch (error) {
      if (error.code === "OWNER_NOT_FOUND") log(`單號分類工具裡找不到件主「${ORDER_OWNER}」`);
      else if (error.status === 401) log("密鑰錯誤：請執行 node taobao-desktop-sync.mjs --set-secret");
      else log(`送出訂單失敗：${error.message}`);
      return;
    }
  } else {
    log(`訂單檢查完成｜${resolvedOrderIds.length} 筆新訂單都沒有快遞單號（虛擬商品）`);
  }

  resolvedOrderIds.forEach((id) => seenOrders.add(id));
  saveState();
}

async function maybeSyncOrders() {
  if (Date.now() - lastOrderCheck < ORDER_POLL_MS) return;
  lastOrderCheck = Date.now();
  saveState();
  try {
    await syncOrders();
  } catch (error) {
    log(`訂單檢查錯誤：${error.message}`);
  }
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

  const found = await findChatPage();
  if (found.error === "TAOBAO_NOT_RUNNING") {
    log("淘寶桌面版沒有以同步模式執行（找不到除錯埠）");
    return;
  }
  if (found.error === "CHAT_NOT_OPEN") {
    log("淘寶桌面版沒有開啟聊天頁（可能被登出，或還沒點開「消息」）");
    return;
  }

  const snapshot = JSON.parse(await evaluateInPage(found.page.webSocketDebuggerUrl, EXTRACT_EXPRESSION));
  if (snapshot.active !== TARGET_CONVERSATION) {
    log(`目前開的對話是「${snapshot.active || "無"}」，請切回「${TARGET_CONVERSATION}」`);
    return;
  }

  const messages = snapshot.messages.map((m) => ({ id: `${m.ts}|${m.text}`, ts: m.ts, sender: m.sender, text: m.text }));
  const unsent = messages.filter((m) => !sentIds.has(m.id));
  if (!unsent.length) {
    log(`運作中｜畫面 ${messages.length} 則，沒有新訊息`);
    return;
  }

  try {
    const result = await postMessages(unsent, secret);
    rememberSent(unsent.map((m) => m.id));
    log(`送出 ${unsent.length} 則｜入庫 ${result.inbound || 0}、待出貨 ${result.quotes || 0}`);
  } catch (error) {
    if (error.status === 401) log("密鑰錯誤：請執行 node taobao-desktop-sync.mjs --set-secret");
    else log(`送出失敗：${error.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--set-secret")) return setSecret();
  if (args.includes("--once")) return syncOnce();
  if (args.includes("--orders")) return syncOrders();

  log(`常駐同步啟動（聊天每 ${POLL_MS / 1000} 秒、訂單每 ${ORDER_POLL_MS / 60000} 分鐘檢查一次）`);
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
