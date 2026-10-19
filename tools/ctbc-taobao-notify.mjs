// 只從 Windows 通知資料庫抽出中國信託的淘寶消費扣款，送到 /api/inbox/messages。
// 其他通知不讀進日誌。密鑰沿用淘寶同步那一把，不寫進這個檔。

import { copyFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parseBankDebit } from "../backend/taobao-paid.js";

const BACKEND_URL = process.env.ORDER_TOOL_BACKEND_URL || "https://order-number-production.up.railway.app";
const APP_DIR = path.join(process.env.LOCALAPPDATA || process.env.HOME || ".", "order-number-taobao-sync");
const CONFIG_FILE = path.join(APP_DIR, "config.json");
const SENT_FILE = path.join(APP_DIR, "ctbc-sent.json");
const FILETIME_OFFSET_MS = 11644473600000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readSecret() {
  return (process.env.INBOX_SECRET || readJson(CONFIG_FILE, {}).inboxSecret || "").trim();
}

function fileTimeToTaipei(filetime) {
  const unixMs = Number(filetime) / 10000 - FILETIME_OFFSET_MS;
  const date = new Date(unixMs);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function decodeXml(text) {
  return String(text || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function toastText(payload) {
  const xml = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload || "");
  const parts = [...xml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)].map((match) => decodeXml(match[1]).trim());
  const joined = parts.filter(Boolean).join("\n");
  if (parseBankDebit(joined)) return joined;
  const stripped = decodeXml(xml.replace(/<[^>]+>/g, " "));
  if (parseBankDebit(stripped)) return stripped.replace(/\s+/g, " ").trim();
  return "";
}

function loadDebits() {
  const src = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Windows", "Notifications", "wpndatabase.db");
  if (!src || !fs.existsSync(src)) {
    return { ok: false, reason: "missing" };
  }
  const dest = path.join(os.tmpdir(), "order-number-wpn.db");
  try {
    copyFileSync(src, dest);
  } catch {
    return { ok: false, reason: "locked" };
  }
  const db = new DatabaseSync(dest, { readOnly: true });
  const rows = db.prepare(
    "SELECT Id, ArrivalTime, Payload FROM Notification " +
    "WHERE CAST(Payload AS TEXT) LIKE '%淘寶%' OR CAST(Payload AS TEXT) LIKE '%淘宝%' " +
    "OR CAST(Payload AS TEXT) LIKE '%支付寶_淘寶%' OR CAST(Payload AS TEXT) LIKE '%支付宝_淘宝%'"
  ).all();
  db.close();
  const debits = [];
  rows.forEach((row) => {
    const text = toastText(row.Payload);
    if (!text) return;
    const ts = fileTimeToTaipei(row.ArrivalTime);
    if (!ts) return;
    debits.push({ id: `ctbc:${row.Id}:${row.ArrivalTime}`, ts, text });
  });
  return { ok: true, debits };
}

export async function sendCtbcTaobaoDebits(options = {}) {
  const log = options.log || ((text) => console.log(text));
  const secret = String(options.secret || readSecret() || "").trim();
  if (!secret) {
    log("中國信託扣款還沒自動送進來：找不到密鑰");
    return { ok: false, reason: "no_secret", sent: 0 };
  }
  const loaded = loadDebits();
  if (!loaded.ok) {
    const reason = loaded.reason === "locked" ? "通知資料庫被鎖" : "找不到通知資料庫";
    log(`中國信託扣款還沒自動送進來：${reason}`);
    return { ok: false, reason: loaded.reason, sent: 0 };
  }
  const sent = new Set(readJson(SENT_FILE, []).slice(-500));
  const fresh = loaded.debits.filter((item) => !sent.has(item.id));
  if (!fresh.length) {
    log("中國信託沒有新的淘寶扣款");
    return { ok: true, reason: "none", sent: 0 };
  }
  const messages = fresh.map((item) => ({
    id: item.id,
    ts: item.ts,
    sender: "中國信託",
    self: false,
    text: item.text
  }));
  const response = await fetch(`${BACKEND_URL}/api/inbox/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ messages, conversation: "中國信託" })
  });
  if (!response.ok) {
    log(`中國信託扣款送出失敗：HTTP ${response.status}`);
    return { ok: false, reason: `http_${response.status}`, sent: 0 };
  }
  fresh.forEach((item) => sent.add(item.id));
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(SENT_FILE, JSON.stringify([...sent].slice(-500)), "utf8");
  log(`中國信託送出 ${fresh.length} 筆淘寶扣款`);
  return { ok: true, reason: "sent", sent: fresh.length };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  sendCtbcTaobaoDebits().catch((error) => {
    console.log(`中國信託扣款未送出：${error.message}`);
    process.exitCode = 1;
  });
}
