// 微信面單資料夾同步：監看本機資料夾裡的新照片，辨識 YT 單號後送到後端入庫。
// 用法：
//   node wechat-label-sync.mjs --once
//   node wechat-label-sync.mjs
//
// 預設資料夾：%USERPROFILE%\OrderNumberWeChatLabels
// 指定人傳面單時，把照片另存／轉發後拖進這個資料夾即可（不必解密微信 DB）。

import fs from "node:fs";
import path from "node:path";
import { createWorker } from "tesseract.js";

const BACKEND_URL = process.env.ORDER_TOOL_BACKEND_URL || "https://order-number-production.up.railway.app";
const POLL_MS = Number(process.env.WECHAT_LABEL_POLL_MS || 10000);
const WATCH_DIR = process.env.WECHAT_LABEL_DIR
  || path.join(process.env.USERPROFILE || process.env.HOME || ".", "OrderNumberWeChatLabels");
const APP_DIR = path.join(process.env.LOCALAPPDATA || process.env.HOME || ".", "order-number-taobao-sync");
const CONFIG_FILE = path.join(APP_DIR, "config.json");
const STATE_FILE = path.join(APP_DIR, "wechat-label-state.json");
const LOG_FILE = path.join(APP_DIR, "wechat-label-sync.log");
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function log(text) {
  const line = `${new Date().toLocaleString("zh-TW", { hour12: false })} ${text}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  } catch {
    // ignore
  }
}

function getSecret() {
  return (process.env.INBOX_SECRET || readJson(CONFIG_FILE, {}).inboxSecret || "").trim();
}

function extractTrackings(text) {
  const found = new Set();
  String(text || "").toUpperCase().replace(/\s+/g, " ").match(/YT\d{10,}|[A-Z]{2}\d{8,40}|\b\d{12,20}\b/g)?.forEach((t) => {
    if (/^(YT\d{10,}|[A-Z]{2}\d{8,40}|\d{12,20})$/.test(t)) found.add(t);
  });
  return [...found];
}

async function postJson(endpoint, body, secret) {
  const res = await fetch(`${BACKEND_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { status: res.status });
  return json;
}

async function heartbeat(secret, payload) {
  try {
    await postJson("/api/inbox/heartbeat", {
      channel: "wechat",
      ok: payload.ok !== false,
      detail: String(payload.detail || "").slice(0, 200),
      conversation: "wechat-folder"
    }, secret);
  } catch {
    // ignore
  }
}

async function ocrFile(worker, filePath) {
  const result = await worker.recognize(filePath);
  return extractTrackings(result?.data?.text || "");
}

async function syncOnce(worker) {
  const secret = getSecret();
  if (!secret) {
    log("尚未設定密鑰：請先跑淘寶同步 --set-secret（共用同一把 INBOX_SECRET）");
    return;
  }
  fs.mkdirSync(WATCH_DIR, { recursive: true });
  const state = readJson(STATE_FILE, { seen: {} });
  const files = fs.readdirSync(WATCH_DIR)
    .filter((name) => IMAGE_EXT.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(WATCH_DIR, name));

  const pendingFiles = [];
  for (const filePath of files) {
    const stat = fs.statSync(filePath);
    const key = `${path.basename(filePath)}:${stat.size}:${stat.mtimeMs}`;
    if (state.seen[key]) continue;
    pendingFiles.push({ filePath, key });
  }

  if (!pendingFiles.length) {
    log(`運作中｜監看 ${WATCH_DIR}｜無新照片`);
    await heartbeat(secret, { ok: true, detail: "無新照片" });
    return;
  }

  const trackings = new Set();
  for (const item of pendingFiles) {
    try {
      const found = await ocrFile(worker, item.filePath);
      found.forEach((t) => trackings.add(t));
      state.seen[item.key] = { at: new Date().toISOString(), trackings: found };
      log(`辨識 ${path.basename(item.filePath)} → ${found.join(", ") || "（無單號）"}`);
    } catch (error) {
      log(`辨識失敗 ${path.basename(item.filePath)}：${error.message}`);
      await heartbeat(secret, { ok: false, detail: `辨識失敗：${error.message}` });
    }
  }
  writeJson(STATE_FILE, { seen: state.seen });

  if (!trackings.size) {
    await heartbeat(secret, { ok: true, detail: `掃了 ${pendingFiles.length} 張，無單號` });
    return;
  }

  try {
    const result = await postJson("/api/inbox/labels", {
      trackings: [...trackings],
      source: "wechat"
    }, secret);
    log(`入庫完成｜成功 ${(result.updated || []).length}、未key ${(result.missing || []).length}`);
    await heartbeat(secret, {
      ok: true,
      detail: `剛入庫 ${(result.updated || []).length} 筆`
    });
  } catch (error) {
    log(`入庫失敗：${error.message}`);
    await heartbeat(secret, { ok: false, detail: `入庫失敗：${error.message}` });
  }
}

async function main() {
  const once = process.argv.includes("--once");
  fs.mkdirSync(WATCH_DIR, { recursive: true });
  log(`微信面單同步啟動｜資料夾 ${WATCH_DIR}`);
  const worker = await createWorker("eng");
  try {
    if (once) {
      await syncOnce(worker);
      return;
    }
    for (;;) {
      try {
        await syncOnce(worker);
      } catch (error) {
        log(`同步錯誤：${error.message}`);
      }
      await sleep(POLL_MS);
    }
  } finally {
    await worker.terminate();
  }
}

main();
