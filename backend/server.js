const express = require("express");
const cors = require("cors");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const { isPaidAck, parseBankDebit, nearestUnpaidQuote, reconcilePaidQuotes, parseTaipeiTime } = require("./taobao-paid");

const app = express();
const PORT = process.env.PORT || 3100;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const AUTH_USERNAME = (process.env.AUTH_USERNAME || "").trim();
const AUTH_PASSWORD_HASH = (process.env.AUTH_PASSWORD_HASH || "").trim();
const AUTH_PASSWORD = (process.env.AUTH_PASSWORD || "").trim();
const AUTH_SESSION_SECRET = (process.env.AUTH_SESSION_SECRET || "").trim();
const AUTH_COOKIE_NAME = (process.env.AUTH_COOKIE_NAME || "order_tool_session").trim();
// "永久記住" 使用超長天數；可用 AUTH_REMEMBER_DAYS 覆蓋
const SESSION_REMEMBER_DAYS = Math.max(1, Number(process.env.AUTH_REMEMBER_DAYS || 36500));
const SESSION_DEFAULT_HOURS = Math.max(1, Number(process.env.AUTH_SESSION_HOURS || 12));
const isProduction = process.env.NODE_ENV === "production";
const AUTH_COOKIE_SAMESITE = (process.env.AUTH_COOKIE_SAMESITE || (isProduction ? "none" : "lax")).trim().toLowerCase();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "storage");
const CONFIGURED_DATA_FILE_PATH = process.env.DATA_FILE_PATH || path.join(DATA_DIR, "data.json");
const FALLBACK_DATA_FILE_PATH = path.join(__dirname, "storage", "data.json");
let activeDataFilePath = CONFIGURED_DATA_FILE_PATH;

const emptyData = { friends: [], taiwan_parcel_groups: [] };

const allowedOrigins = CORS_ORIGIN
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (!allowedOrigins.length) return false;
  if (allowedOrigins.includes("*")) return true;
  return allowedOrigins.includes(origin);
}

const corsConfig = {
  origin(origin, callback) {
    if (isOriginAllowed(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true
};

app.use(helmet());
app.use(cors(corsConfig));
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "TOO_MANY_ATTEMPTS" }
});

function hasConfiguredAuth() {
  return Boolean(AUTH_USERNAME && AUTH_SESSION_SECRET && (AUTH_PASSWORD_HASH || AUTH_PASSWORD));
}

function safeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function verifyPassword(rawPassword) {
  const value = String(rawPassword || "");
  if (AUTH_PASSWORD_HASH) {
    return bcrypt.compare(value, AUTH_PASSWORD_HASH);
  }
  return safeEqualString(value, AUTH_PASSWORD);
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString("base64url");
}

function decodeBase64UrlJson(encoded) {
  try {
    const text = Buffer.from(encoded, "base64url").toString("utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function signToken(unsignedPayload) {
  return crypto.createHmac("sha256", AUTH_SESSION_SECRET).update(unsignedPayload).digest("base64url");
}

function createSessionToken({ remember }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresInSec = remember ? SESSION_REMEMBER_DAYS * 24 * 60 * 60 : SESSION_DEFAULT_HOURS * 60 * 60;
  const payload = {
    sub: AUTH_USERNAME,
    iat: nowSec,
    exp: nowSec + expiresInSec,
    remember: Boolean(remember),
    jti: crypto.randomBytes(12).toString("hex")
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signToken(encodedPayload);
  return {
    token: `${encodedPayload}.${signature}`,
    payload
  };
}

function verifySessionToken(token) {
  const text = String(token || "");
  if (!text.includes(".")) return null;
  const [encodedPayload, signature] = text.split(".");
  if (!encodedPayload || !signature) return null;
  if (!AUTH_SESSION_SECRET) return null;
  const expected = signToken(encodedPayload);
  if (!safeEqualString(signature, expected)) return null;
  const payload = decodeBase64UrlJson(encodedPayload);
  if (!payload || payload.sub !== AUTH_USERNAME) return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function getSessionTokenFromRequest(req) {
  const cookieToken = req.cookies?.[AUTH_COOKIE_NAME];
  if (cookieToken) return cookieToken;
  const authHeader = String(req.headers.authorization || "").trim();
  if (authHeader.startsWith("Bearer ")) return authHeader.slice("Bearer ".length).trim();
  return "";
}

function writeSessionCookie(res, token, remember) {
  const sameSite = ["lax", "strict", "none"].includes(AUTH_COOKIE_SAMESITE) ? AUTH_COOKIE_SAMESITE : "lax";
  const options = {
    httpOnly: true,
    // SameSite=None 需要 Secure=true，供 Netlify(前端) + Railway(後端) 跨網域登入使用
    secure: isProduction || sameSite === "none",
    sameSite,
    path: "/"
  };
  if (remember) {
    options.maxAge = SESSION_REMEMBER_DAYS * 24 * 60 * 60 * 1000;
  }
  res.cookie(AUTH_COOKIE_NAME, token, options);
}

function clearSessionCookie(res) {
  const sameSite = ["lax", "strict", "none"].includes(AUTH_COOKIE_SAMESITE) ? AUTH_COOKIE_SAMESITE : "lax";
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction || sameSite === "none",
    sameSite,
    path: "/"
  });
}

function requireAppAuth(req, res, next) {
  if (!hasConfiguredAuth()) {
    return res.status(503).json({ ok: false, error: "AUTH_NOT_CONFIGURED" });
  }
  const token = getSessionTokenFromRequest(req);
  const payload = verifySessionToken(token);
  if (!payload) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  req.auth = payload;
  return next();
}

function normalizeShippingEntry(entry) {
  return {
    id: entry?.id || `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: (entry?.name || "").trim(),
    phone: (entry?.phone || "").trim(),
    address: (entry?.address || "").trim()
  };
}

function normalizeShippingList(rawList, fallbackSingle) {
  if (Array.isArray(rawList)) {
    return rawList.map((entry) => normalizeShippingEntry(entry));
  }
  if (fallbackSingle && typeof fallbackSingle === "object") {
    const normalized = normalizeShippingEntry(fallbackSingle);
    if (normalized.name || normalized.phone || normalized.address) return [normalized];
  }
  return [];
}

function normalizeShippingProfiles(rawProfiles) {
  const p = rawProfiles || {};
  return {
    convenience_list: normalizeShippingList(p.convenience_list, p.convenience),
    address_list: normalizeShippingList(p.address_list, p.address)
  };
}

function normalizeDataShape(raw) {
  const friendsRaw = Array.isArray(raw?.friends) ? raw.friends : [];
  const friends = friendsRaw.map((friend) => {
    return {
      ...friend,
      parcels: Array.isArray(friend?.parcels) ? friend.parcels : [],
      shipping_profiles: normalizeShippingProfiles(friend?.shipping_profiles)
    };
  });

  const groupsRaw = Array.isArray(raw?.taiwan_parcel_groups) ? raw.taiwan_parcel_groups : [];
  const groups = groupsRaw.map((group) => ({
    ...group,
    settlement_total_cny: Number.isFinite(Number(group?.settlement_total_cny)) ? Number(group.settlement_total_cny) : null,
    settlement_total_twd: Number.isFinite(Number(group?.settlement_total_twd)) ? Number(group.settlement_total_twd) : null,
    shipping_method: (group?.shipping_method || "").trim(),
    shipping_address: (group?.shipping_address || "").trim()
  }));
  const version = Number.isInteger(raw?.version) && raw.version >= 0 ? raw.version : 0;
  return { friends, taiwan_parcel_groups: groups, version };
}

async function ensureDataFileAt(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(emptyData, null, 2), "utf8");
  }
}

async function ensureDataFile() {
  try {
    await ensureDataFileAt(activeDataFilePath);
  } catch (error) {
    // Keep service alive even if DATA_DIR is misconfigured on Railway.
    if (activeDataFilePath !== FALLBACK_DATA_FILE_PATH) {
      console.error("Primary data path unavailable, falling back:", activeDataFilePath, error);
      activeDataFilePath = FALLBACK_DATA_FILE_PATH;
      await ensureDataFileAt(activeDataFilePath);
      return;
    }
    throw error;
  }
}

async function readDataFile() {
  await ensureDataFile();
  const raw = await fs.readFile(activeDataFilePath, "utf8");
  const parsed = JSON.parse((raw || "{}").replace(/^\uFEFF/, ""));
  return normalizeDataShape(parsed);
}

async function writeDataFile(data) {
  await ensureDataFile();
  const normalized = normalizeDataShape(data);
  const tempPath = `${activeDataFilePath}.tmp`;

  await fs.writeFile(tempPath, JSON.stringify(normalized, null, 2), "utf8");
  await fs.rename(tempPath, activeDataFilePath);

  return normalized;
}

const BACKUP_KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 200));

async function backupCurrentDataFile() {
  try {
    const raw = await fs.readFile(activeDataFilePath, "utf8");
    const dir = path.join(path.dirname(activeDataFilePath), "backups");
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.writeFile(path.join(dir, `data-${stamp}.json`), raw, "utf8");

    const files = (await fs.readdir(dir))
      .filter((name) => name.startsWith("data-") && name.endsWith(".json"))
      .sort();
    const stale = files.slice(0, Math.max(0, files.length - BACKUP_KEEP));
    await Promise.all(stale.map((name) => fs.unlink(path.join(dir, name)).catch(() => {})));
  } catch (error) {
    console.error("Backup failed:", error);
  }
}

let writeChain = Promise.resolve();

function withWriteLock(task) {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => {});
  return run;
}

async function handleDataWrite(req, res) {
  const body = req.body;
  const payload = body?.data ?? body;
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "INVALID_PAYLOAD" });
  }
  const baseVersion = body?.data ? body.base_version : undefined;

  try {
    const result = await withWriteLock(async () => {
      const current = await readDataFile();
      if (baseVersion !== undefined && baseVersion !== null && Number(baseVersion) !== current.version) {
        return { conflict: true, current };
      }
      await backupCurrentDataFile();
      const saved = await writeDataFile({ ...payload, version: current.version + 1 });
      return { conflict: false, saved };
    });

    if (result.conflict) {
      return res.status(409).json({ ok: false, error: "VERSION_CONFLICT", data: result.current });
    }
    return res.json(result.saved);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "WRITE_FAILED" });
  }
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "order-tool-backend", path: "/" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "order-tool-backend", data_path: activeDataFilePath });
});

app.get("/api/auth/session", (req, res) => {
  if (!hasConfiguredAuth()) {
    return res.status(503).json({ ok: false, error: "AUTH_NOT_CONFIGURED" });
  }
  const payload = verifySessionToken(getSessionTokenFromRequest(req));
  if (!payload) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return res.json({ ok: true, username: payload.sub, expires_at: new Date(payload.exp * 1000).toISOString() });
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    if (!hasConfiguredAuth()) {
      return res.status(503).json({ ok: false, error: "AUTH_NOT_CONFIGURED" });
    }
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const remember = Boolean(req.body?.remember);

    if (!username || !password) {
      return res.status(400).json({ ok: false, error: "MISSING_CREDENTIALS" });
    }
    if (!safeEqualString(username, AUTH_USERNAME)) {
      return res.status(401).json({ ok: false, error: "INVALID_CREDENTIALS" });
    }
    const passOk = await verifyPassword(password);
    if (!passOk) {
      return res.status(401).json({ ok: false, error: "INVALID_CREDENTIALS" });
    }

    const session = createSessionToken({ remember });
    writeSessionCookie(res, session.token, remember);
    return res.json({
      ok: true,
      username: AUTH_USERNAME,
      remember: Boolean(remember),
      expires_at: new Date(session.payload.exp * 1000).toISOString(),
      token_type: "Bearer",
      session_token: session.token
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "LOGIN_FAILED" });
  }
});

app.post("/api/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  return res.json({ ok: true });
});

app.get("/api/order-tool/data", requireAppAuth, async (_req, res) => {
  try {
    const data = await readDataFile();
    return res.json(data);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "READ_FAILED" });
  }
});

app.put("/api/order-tool/data", requireAppAuth, handleDataWrite);
app.post("/api/order-tool/data", requireAppAuth, handleDataWrite);
app.patch("/api/order-tool/data", requireAppAuth, handleDataWrite);


const HORUS_READ_SECRET = (process.env.HORUS_READ_SECRET || "").trim();
const UNSET_TAIWAN_PREFIX = "__UNSET_TW__";

function requireHorusSecret(req, res, next) {
  if (!HORUS_READ_SECRET) {
    return res.status(503).json({ ok: false, error: "HORUS_READ_SECRET not configured" });
  }
  const auth = (req.headers.authorization || "").trim();
  if (auth !== `Bearer ${HORUS_READ_SECRET}`) {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }
  return next();
}

function parseTaiwanTrackingIds(raw) {
  const lf = String.fromCharCode(10);
  const cr = String.fromCharCode(13);
  const normalized = (raw || "").replaceAll("，", ",").replaceAll(cr, lf);
  const parts = normalized
    .split(",")
    .flatMap((part) => part.split(lf))
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

function isUnsetTaiwanTrackingId(value) {
  return (value || "").startsWith(UNSET_TAIWAN_PREFIX);
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeTrackingForHorus(rawId, shippingMethod) {
  const compact = String(rawId || "").trim().replace(/\s+/g, "");
  if ((shippingMethod || "").trim() === "超商" || /[a-zA-Z]/.test(compact)) {
    return compact.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  }
  return digitsOnly(compact);
}

function mergeParcelItems(existing, friendName, remark) {
  const items = Array.isArray(existing) ? [...existing] : [];
  items.push({
    friend_name: (friendName || "").trim(),
    remark: (remark || "").trim(),
  });
  return items;
}

function buildParcelIndex(data) {
  const byId = new Map();
  for (const friend of data.friends || []) {
    for (const parcel of friend.parcels || []) {
      byId.set(parcel.id, {
        friend_name: (friend.name || "").trim(),
        remark: (parcel.remark || "").trim(),
        china_tracking: (parcel.tracking_id_china || "").trim(),
      });
    }
  }
  return byId;
}

function parcelItemsFromGroup(group, parcelIndex) {
  const lines = [];
  for (const id of group?.china_tracking_ids || []) {
    const parcel = parcelIndex.get(id);
    if (parcel) lines.push(parcel);
  }
  return dedupeParcelItems(lines);
}

function dedupeParcelItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const name = (item.friend_name || "").trim() || "未知";
    const remark = (item.remark || "").trim();
    const china = (item.china_tracking || "").trim();
    const key = `${name}\0${remark}\0${china}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      friend_name: name,
      remark,
      ...(china ? { china_tracking: china } : {}),
    });
  }
  return out;
}

function buildShippedTracks(data, days) {
  const groupById = new Map();
  for (const group of data.taiwan_parcel_groups || []) {
    groupById.set(group.id, group);
  }

  const parcelIndex = buildParcelIndex(data);

  const cutoff = Date.now() - Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000;
  const byTracking = new Map();

  for (const friend of data.friends || []) {
    for (const parcel of friend.parcels || []) {
      if (parcel.status !== "shipped_to_taiwan") continue;

      const shippedAt = parcel.shipped_to_taiwan_time || "";
      const shippedTs = Date.parse(shippedAt);
      if (Number.isFinite(shippedTs) && shippedTs < cutoff) continue;

      const group = groupById.get(parcel.taiwan_parcel_group_id);
      const rawTaiwanId = (group?.tracking_id_taiwan || "").trim();
      if (!rawTaiwanId || isUnsetTaiwanTrackingId(rawTaiwanId)) continue;

      const trackingIds = parseTaiwanTrackingIds(rawTaiwanId);
      for (const rawId of trackingIds) {
        const shippingMethod = (group?.shipping_method || "").trim();
        const trackingNumber = normalizeTrackingForHorus(rawId, shippingMethod);
        if (!trackingNumber) continue;

        const shippingAddress = (group?.shipping_address || "").trim();
        const parcelLine = {
          friend_name: (friend.name || "").trim(),
          remark: (parcel.remark || "").trim(),
          china_tracking: (parcel.tracking_id_china || "").trim(),
        };
        const groupItems = parcelItemsFromGroup(group, parcelIndex);

        const prev = byTracking.get(trackingNumber);
        if (!prev) {
          byTracking.set(trackingNumber, {
            tracking_number: trackingNumber,
            friend_name: friend.name || "",
            remark: parcel.remark || "",
            china_tracking: parcel.tracking_id_china || "",
            shipped_at: shippedAt || null,
            shipping_method: shippingMethod,
            shipping_address: shippingAddress,
            parcel_items: groupItems.length > 0 ? groupItems : dedupeParcelItems([parcelLine]),
          });
          continue;
        }

        const prevTs = Date.parse(prev.shipped_at || "");
        const nextTs = Date.parse(shippedAt || "");
        const keepNewer = Number.isFinite(nextTs) && (!Number.isFinite(prevTs) || nextTs >= prevTs);
        const base = keepNewer ? { ...prev, shipped_at: shippedAt || prev.shipped_at } : { ...prev };
        if (keepNewer && shippingAddress) base.shipping_address = shippingAddress;
        if (!base.shipping_address && shippingAddress) base.shipping_address = shippingAddress;

        const mergedItems = dedupeParcelItems([
          ...(groupItems.length > 0 ? groupItems : []),
          ...(prev.parcel_items || []),
          parcelLine,
        ]);

        byTracking.set(trackingNumber, {
          ...base,
          parcel_items: mergedItems,
        });
      }
    }
  }

  const items = [...byTracking.values()].sort((a, b) => Date.parse(b.shipped_at || 0) - Date.parse(a.shipped_at || 0));
  return items;
}

function lookupShippingAddress(data, trackingNumber) {
  for (const group of data.taiwan_parcel_groups || []) {
    const rawTaiwanId = (group?.tracking_id_taiwan || "").trim();
    if (!rawTaiwanId || isUnsetTaiwanTrackingId(rawTaiwanId)) continue;

    const method = (group?.shipping_method || "").trim();
    for (const rawId of parseTaiwanTrackingIds(rawTaiwanId)) {
      if (normalizeTrackingForHorus(rawId, method) === trackingNumber) {
        return (group.shipping_address || "").trim();
      }
    }
  }
  return "";
}

app.get("/api/horus/shipped-tracks", requireHorusSecret, async (req, res) => {
  try {
    const days = Number(req.query.days || 7);
    const data = await readDataFile();
    const items = buildShippedTracks(data, days);
    return res.json({ ok: true, period_days: Math.max(1, Number(days) || 7), count: items.length, items });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "READ_FAILED" });
  }
});

app.get("/api/horus/address-by-tracking", requireHorusSecret, async (req, res) => {
  try {
    const method = String(req.query.method || "").trim();
    const trackingNumber = normalizeTrackingForHorus(String(req.query.tracking || ""), method);
    if (!trackingNumber) {
      return res.status(400).json({ ok: false, error: "INVALID_TRACKING" });
    }

    const data = await readDataFile();
    return res.json({
      ok: true,
      tracking_number: trackingNumber,
      shipping_address: lookupShippingAddress(data, trackingNumber),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "READ_FAILED" });
  }
});

const INBOX_SECRET = (process.env.INBOX_SECRET || "").trim();
const INBOX_MAX_PROCESSED = 5000;
const INBOX_MAX_LOG = 100;
const INBOX_ADDRESS_WINDOW_MS = 60 * 60 * 1000;

const UNASSIGNED_OWNER_NAME = "件主未填";
const LEGACY_UNASSIGNED_OWNER_NAME = "未分件主";
const INBOX_WEIGHT_LINE = /^(\d+(?:\.\d+)?)\s*(?:kg|公斤)?\s+([A-Za-z0-9]{6,})(?:\s+.*)?$/i;
const INBOX_PAY_LINE = /^拍\s*[:：]?\s*(\d+(?:\.\d+)?)/;
const INBOX_TOTAL_LINE = /^(?:合计|合計)\s*[:：]?\s*(\d+(?:\.\d+)?)/;
const INBOX_PHONE = /09\d{8}/;
const INBOX_TAIWAN_LINE = /^(?:台[湾灣])?(?:单号|單號)?\s*[:：]?\s*(\d{9,14})$/;
const INBOX_TAIWAN_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function requireInboxSecret(req, res, next) {
  if (!INBOX_SECRET) return res.status(503).json({ ok: false, error: "INBOX_SECRET_NOT_CONFIGURED" });
  const auth = String(req.headers.authorization || "").trim();
  if (!safeEqualString(auth, `Bearer ${INBOX_SECRET}`)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function inboxFilePath() {
  return path.join(path.dirname(activeDataFilePath), "inbox.json");
}

const SYNC_STALE_MS = 3 * 60 * 1000;
const LINE_DEFAULT_INTERVAL_SEC = 900;
const LINE_STALE_GRACE_SEC = 300;

function normalizeLineIntervalSec(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 60 || n > 86400) return LINE_DEFAULT_INTERVAL_SEC;
  return n;
}

function lineStaleMs(sync) {
  const intervalSec = normalizeLineIntervalSec(sync?.intervalSec);
  return (intervalSec + LINE_STALE_GRACE_SEC) * 1000;
}

async function readInbox() {
  try {
    const raw = await fs.readFile(inboxFilePath(), "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return {
      processed: Array.isArray(parsed.processed) ? parsed.processed : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      log: Array.isArray(parsed.log) ? parsed.log : [],
      sync: parsed.sync && typeof parsed.sync === "object" ? parsed.sync : null,
      syncWechat: parsed.syncWechat && typeof parsed.syncWechat === "object" ? parsed.syncWechat : null,
      syncLine: parsed.syncLine && typeof parsed.syncLine === "object" ? parsed.syncLine : null,
      paid_acks: Array.isArray(parsed.paid_acks) ? parsed.paid_acks : [],
      bank_debits: Array.isArray(parsed.bank_debits) ? parsed.bank_debits : []
    };
  } catch {
    return { processed: [], pending: [], log: [], sync: null, syncWechat: null, syncLine: null, paid_acks: [], bank_debits: [] };
  }
}

async function writeInbox(inbox) {
  const next = {
    processed: inbox.processed.slice(-INBOX_MAX_PROCESSED),
    pending: inbox.pending,
    log: inbox.log.slice(-INBOX_MAX_LOG),
    paid_acks: (inbox.paid_acks || []).slice(-200),
    bank_debits: (inbox.bank_debits || []).slice(-200)
  };
  if (inbox.sync && typeof inbox.sync === "object") next.sync = inbox.sync;
  if (inbox.syncWechat && typeof inbox.syncWechat === "object") next.syncWechat = inbox.syncWechat;
  if (inbox.syncLine && typeof inbox.syncLine === "object") next.syncLine = inbox.syncLine;
  const filePath = inboxFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(`${filePath}.tmp`, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(`${filePath}.tmp`, filePath);
}

function buildSyncStatus(sync, name = "淘寶", staleMs = SYNC_STALE_MS) {
  if (!sync?.lastHeartbeatAt) {
    return { state: "offline", label: `${name}同步未連線`, detail: "", lastHeartbeatAt: null };
  }
  // Failed heartbeat shows degraded immediately; do not wait for the next schedule.
  if (sync.ok === false) {
    return {
      state: "degraded",
      label: `${name}同步異常`,
      detail: sync.detail || "",
      lastHeartbeatAt: sync.lastHeartbeatAt,
      conversation: sync.conversation || ""
    };
  }
  const ageMs = Date.now() - Date.parse(sync.lastHeartbeatAt);
  const limit = Number.isFinite(staleMs) && staleMs > 0 ? staleMs : SYNC_STALE_MS;
  if (!Number.isFinite(ageMs) || ageMs > limit) {
    return {
      state: "offline",
      label: `${name}同步未連線`,
      detail: sync.detail || "",
      lastHeartbeatAt: sync.lastHeartbeatAt
    };
  }
  return {
    state: "running",
    label: `${name}同步運作中`,
    detail: sync.detail || "",
    lastHeartbeatAt: sync.lastHeartbeatAt,
    conversation: sync.conversation || ""
  };
}

function hashMessageId(id) {
  return crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 20);
}

function parseTaobaoTime(ts) {
  const value = Date.parse(`${String(ts || "").trim().replace(" ", "T")}+08:00`);
  return Number.isFinite(value) ? value : Date.now();
}

function parseInboxMessage(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const taiwanMatch = lines.length === 1 ? lines[0].match(INBOX_TAIWAN_LINE) : null;
  if (taiwanMatch) return { type: "taiwan", items: [], cny: null, totalWeight: null, address: "", taiwanTracking: taiwanMatch[1] };
  const items = [];
  const otherLines = [];
  let cny = null;
  let totalWeight = null;

  lines.forEach((line) => {
    const weightMatch = line.match(INBOX_WEIGHT_LINE);
    if (weightMatch) {
      items.push({ weight: Number(weightMatch[1]), tracking: weightMatch[2] });
      return;
    }
    const payMatch = line.match(INBOX_PAY_LINE);
    if (payMatch) {
      cny = Number(payMatch[1]);
      return;
    }
    const totalMatch = line.match(INBOX_TOTAL_LINE);
    if (totalMatch) {
      totalWeight = Number(totalMatch[1]);
      return;
    }
    otherLines.push(line);
  });

  const address = otherLines.some((line) => INBOX_PHONE.test(line.replace(/[\s-]/g, "")))
    ? otherLines.join(" ").replace(/\s+/g, " ").trim()
    : "";

  // "拍N" is the forwarder asking for payment, which only happens on a shipping quote.
  let type = "ignore";
  if (items.length && cny !== null) type = "quote";
  else if (items.length) type = "inbound";
  else if (address) type = "address";

  return { type, items, cny, totalWeight, address };
}

function buildServerTrackingIndex(data) {
  const index = new Map();
  data.friends.forEach((friend) => {
    friend.parcels.forEach((parcel) => {
      const key = String(parcel.tracking_id_china || "").trim().toLowerCase();
      if (!key) return;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ friend, parcel });
    });
  });
  return index;
}

function applyInboundToData(data, items, nowIso) {
  const index = buildServerTrackingIndex(data);
  const updated = [];
  const missing = [];
  const skipped = [];

  items.forEach(({ tracking, weight }) => {
    const entries = index.get(String(tracking || "").toLowerCase()) || [];
    if (!entries.length) {
      missing.push(tracking);
      return;
    }
    const hasWeight = Number.isFinite(weight);
    entries.forEach(({ friend, parcel }) => {
      if (parcel.status === "shipped_to_taiwan") {
        skipped.push(tracking);
        return;
      }
      const changed = parcel.status !== "arrived_at_warehouse"
        || (hasWeight && Number(parcel.weight_kg) !== weight);
      if (hasWeight) parcel.weight_kg = weight;
      if (parcel.status !== "arrived_at_warehouse") {
        parcel.status = "arrived_at_warehouse";
        parcel.arrived_at_warehouse_time = nowIso;
      }
      if (changed) {
        updated.push({
          tracking,
          weight: hasWeight ? weight : Number(parcel.weight_kg) || 0,
          owner: friend.name || "",
          remark: parcel.remark || ""
        });
      }
    });
  });

  return { updated, missing, skipped };
}

function isUnassignedOwnerName(name) {
  const value = String(name || "").trim();
  return value === UNASSIGNED_OWNER_NAME || value === LEGACY_UNASSIGNED_OWNER_NAME;
}

function ensureUnassignedOwner(data) {
  const existing = data.friends.find((friend) => isUnassignedOwnerName(friend.name));
  if (existing) {
    existing.name = UNASSIGNED_OWNER_NAME;
    if (!Array.isArray(existing.parcels)) existing.parcels = [];
    return existing;
  }
  const owner = {
    id: crypto.randomUUID(),
    name: UNASSIGNED_OWNER_NAME,
    receipt_info: { name: "", phone: "", address: "", id_number: "" },
    shipping_profiles: {
      convenience_list: [],
      address_list: []
    },
    parcels: []
  };
  data.friends.push(owner);
  return owner;
}

function applyDetectedQuoteFields(parcel, pending) {
  if (!pending) return false;
  let changed = false;
  const taiwan = String(pending.taiwan_tracking || "").trim();
  if (taiwan && parcel.detected_taiwan_tracking !== taiwan) {
    parcel.detected_taiwan_tracking = taiwan;
    changed = true;
  }
  const paid = Number(pending.paid_twd);
  if (Number.isFinite(paid) && parcel.paid_twd !== paid) {
    parcel.paid_twd = paid;
    const rate = Number(pending.paid_rate);
    parcel.paid_rate = Number.isFinite(rate) ? rate : null;
    changed = true;
  }
  return changed;
}

function createUnassignedParcels(data, items, arrivedIso, createdIso, pending) {
  const index = buildServerTrackingIndex(data);
  const created = [];
  items.forEach(({ tracking, weight }) => {
    const raw = String(tracking || "").trim();
    const key = raw.toLowerCase();
    if (!key || index.has(key)) return;
    const owner = ensureUnassignedOwner(data);
    const parcel = {
      id: crypto.randomUUID(),
      tracking_id_china: raw,
      remark: "",
      status: "arrived_at_warehouse",
      shipping_priority: "normal",
      weight_kg: Number.isFinite(weight) ? weight : 0,
      taiwan_parcel_group_id: null,
      detected_taiwan_tracking: "",
      paid_twd: null,
      paid_rate: null,
      created_at: createdIso,
      arrived_at_warehouse_time: arrivedIso,
      shipped_to_taiwan_time: null
    };
    applyDetectedQuoteFields(parcel, pending);
    owner.parcels.push(parcel);
    index.set(key, [{ friend: owner, parcel }]);
    created.push({ tracking: raw, weight: parcel.weight_kg, owner: owner.name });
  });
  return created;
}

function stampUnassignedFromPending(data, inbox) {
  const index = buildServerTrackingIndex(data);
  let changed = false;
  (inbox.pending || []).forEach((pending) => {
    (pending.items || []).forEach((item) => {
      const key = String(item.tracking || "").trim().toLowerCase();
      if (!key) return;
      const entries = index.get(key) || [];
      if (!entries.length) {
        const created = createUnassignedParcels(
          data,
          [{ tracking: item.tracking, weight: item.weight }],
          pending.created_at || new Date().toISOString(),
          pending.created_at || new Date().toISOString(),
          pending
        );
        if (created.length) changed = true;
        return;
      }
      entries.forEach(({ friend, parcel }) => {
        if (!isUnassignedOwnerName(friend.name)) return;
        if (applyDetectedQuoteFields(parcel, pending)) changed = true;
      });
    });
  });
  return changed;
}

function createUnassignedInboundParcels(data, items, arrivedIso, createdIso) {
  return createUnassignedParcels(data, items, arrivedIso, createdIso, null);
}

function normalizeLabelTrackings(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  list.forEach((value) => {
    const tracking = String(value || "").trim().toUpperCase().replace(/\s+/g, "");
    // WeChat labels are usually YT…; also accept common CN express shapes.
    if (!/^(YT\d{10,}|[A-Z]{2}\d{8,40}|\d{10,20})$/.test(tracking)) return;
    const key = tracking.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(tracking);
  });
  return out;
}

async function inboundLabelTrackings(trackings, source = "wechat") {
  return withWriteLock(async () => {
    const nowIso = new Date().toISOString();
    const data = await readDataFile();
    const items = trackings.map((tracking) => ({ tracking, weight: null }));
    const result = applyInboundToData(data, items, nowIso);
    if (result.updated.length) {
      await backupCurrentDataFile();
      await writeDataFile({ ...data, version: data.version + 1 });
    }
    const inbox = await readInbox();
    if (result.updated.length || result.missing.length) {
      const parts = [];
      if (result.updated.length) {
        parts.push(`${source === "wechat" ? "微信面單" : source}入庫 ${result.updated.length} 筆：${result.updated.map((u) => `${u.tracking} ${u.owner}`).join("、")}`);
      }
      if (result.missing.length) parts.push(`單號未key：${result.missing.join("、")}`);
      if (result.skipped.length) parts.push(`已出轉運略過：${result.skipped.join("、")}`);
      inbox.log.push({
        at: nowIso,
        message_ts: "",
        type: "wechat_label",
        text: parts.join("；") || `${source} 面單無變更`
      });
    }
    inbox.syncWechat = {
      ok: true,
      detail: result.updated.length
        ? `剛入庫 ${result.updated.length} 筆`
        : (result.missing.length ? `未key ${result.missing.length} 筆` : "已掃過，無新入庫"),
      conversation: source,
      lastHeartbeatAt: nowIso
    };
    await writeInbox(inbox);
    return { ...result, source };
  });
}

// The forwarder sends the Taiwan number after payment, either before or after the shipment is confirmed in the app.
function assignTaiwanTracking(data, inbox, tracking, messageAt) {
  if (data.taiwan_parcel_groups.some((group) => (group.tracking_id_taiwan || "").trim() === tracking)) return "duplicate";
  if (inbox.pending.some((pending) => pending.taiwan_tracking === tracking)) return "duplicate";

  const pending = [...inbox.pending].reverse().find((p) => !p.taiwan_tracking
    && messageAt - parseTaobaoTime(p.message_ts) >= 0
    && messageAt - parseTaobaoTime(p.message_ts) <= INBOX_TAIWAN_WINDOW_MS);
  if (pending) {
    pending.taiwan_tracking = tracking;
    return "pending";
  }

  const group = data.taiwan_parcel_groups
    .filter((g) => (g.tracking_id_taiwan || "").startsWith(UNSET_TAIWAN_PREFIX))
    .filter((g) => Math.abs(messageAt - Date.parse(g.created_at || "")) <= INBOX_TAIWAN_WINDOW_MS)
    .sort((a, b) => Date.parse(b.created_at || "") - Date.parse(a.created_at || ""))[0];
  if (group) {
    group.tracking_id_taiwan = tracking;
    return "group";
  }
  return "none";
}

async function processInboxMessages(messages) {
  return withWriteLock(async () => {
    const inbox = await readInbox();
    if (!Array.isArray(inbox.paid_acks)) inbox.paid_acks = [];
    if (!Array.isArray(inbox.bank_debits)) inbox.bank_debits = [];
    const processedSet = new Set(inbox.processed);
    const fresh = messages
      .map((message) => ({ ...message, hash: hashMessageId(message.id) }))
      .filter((message) => !processedSet.has(message.hash))
      .sort((a, b) => parseTaobaoTime(a.ts) - parseTaobaoTime(b.ts));

    const summary = { received: messages.length, fresh: fresh.length, inbound: 0, quotes: 0, addresses: 0, taiwan: 0 };
    if (!fresh.length) return summary;

    let data = null;
    let dataChanged = false;
    const nowIso = new Date().toISOString();

    for (const message of fresh) {
      const bankDebit = parseBankDebit(message.text);
      if (bankDebit) {
        inbox.bank_debits.push({ id: message.hash, at: message.ts, twd: bankDebit.twd, state: "open" });
        reconcilePaidQuotes(inbox, nowIso);
        inbox.processed.push(message.hash);
        continue;
      }
      if (isPaidAck(message.text)) {
        const paidAt = parseTaipeiTime(message.ts);
        const quote = nearestUnpaidQuote(inbox.pending, paidAt);
        inbox.paid_acks.push({
          id: message.hash,
          at: message.ts,
          quote_id: quote ? quote.id : "",
          state: "open"
        });
        if (!quote) {
          inbox.log.push({
            at: nowIso,
            message_ts: message.ts,
            type: "paid",
            text: "淘寶/收到付了，前面沒有未掛台幣的拍"
          });
        }
        reconcilePaidQuotes(inbox, nowIso);
        inbox.processed.push(message.hash);
        continue;
      }
      const parsed = parseInboxMessage(message.text);
      const messageAt = parseTaobaoTime(message.ts);

      if (parsed.type === "inbound") {
        data = data || await readDataFile();
        const result = applyInboundToData(data, parsed.items, nowIso);
        const arrivedIso = new Date(messageAt).toISOString();
        const missingKeys = new Set(result.missing.map((tracking) => String(tracking || "").toLowerCase()));
        const missingItems = parsed.items.filter((item) => missingKeys.has(String(item.tracking || "").toLowerCase()));
        const created = createUnassignedInboundParcels(data, missingItems, arrivedIso, nowIso);
        const createdKeys = new Set(created.map((item) => item.tracking.toLowerCase()));
        const stillMissing = [];
        const seenMissing = new Set();
        result.missing.forEach((tracking) => {
          const key = String(tracking || "").toLowerCase();
          if (!key || createdKeys.has(key) || seenMissing.has(key)) return;
          seenMissing.add(key);
          stillMissing.push(tracking);
        });
        if (result.updated.length || created.length) dataChanged = true;
        summary.inbound += result.updated.length + created.length;
        if (result.updated.length || created.length || stillMissing.length) {
          const parts = [];
          if (result.updated.length) {
            parts.push(`淘寶/自動入庫 ${result.updated.length} 筆：${result.updated.map((u) => `${u.weight.toFixed(1)} ${u.tracking} ${u.owner}`).join("、")}`);
          }
          if (created.length) {
            parts.push(`淘寶/件主未填入倉 ${created.length} 筆：${created.map((item) => `${Number(item.weight).toFixed(1)} ${item.tracking}`).join("、")}`);
          }
          if (stillMissing.length) parts.push(`淘寶/單號未key：${stillMissing.join("、")}`);
          inbox.log.push({ at: nowIso, message_ts: message.ts, type: "inbound", text: parts.join("；") });
        }
      } else if (parsed.type === "quote") {
        data = data || await readDataFile();
        const indexBefore = buildServerTrackingIndex(data);
        const missingItems = parsed.items.filter((item) => !(indexBefore.get(String(item.tracking || "").toLowerCase()) || []).length);
        const created = createUnassignedParcels(data, missingItems, new Date(messageAt).toISOString(), nowIso, null);
        if (created.length) dataChanged = true;
        const index = buildServerTrackingIndex(data);
        const shippable = parsed.items.filter((item) => (index.get(item.tracking.toLowerCase()) || [])
          .some(({ parcel }) => parcel.status !== "shipped_to_taiwan"));
        if (shippable.length) {
          inbox.pending.push({
            id: `pend_${message.hash}`,
            message_ts: message.ts,
            created_at: nowIso,
            items: parsed.items,
            total_weight: parsed.totalWeight,
            cny: parsed.cny,
            address: parsed.address
          });
          summary.quotes += 1;
          const parts = [`淘寶/收到出貨報價 ${parsed.items.length} 筆，拍 ${parsed.cny}，待確認`];
          if (created.length) parts.push(`件主未填入單號管理 ${created.length} 筆：${created.map((item) => item.tracking).join("、")}`);
          inbox.log.push({ at: nowIso, message_ts: message.ts, type: "quote", text: parts.join("；") });
        }
      } else if (parsed.type === "address") {
        const target = [...inbox.pending].reverse().find((pending) => !pending.address
          && Math.abs(messageAt - parseTaobaoTime(pending.message_ts)) <= INBOX_ADDRESS_WINDOW_MS);
        if (target) {
          target.address = parsed.address;
          summary.addresses += 1;
        }
      } else if (parsed.type === "taiwan" && !message.self) {
        data = data || await readDataFile();
        const result = assignTaiwanTracking(data, inbox, parsed.taiwanTracking, messageAt);
        if (result === "group") dataChanged = true;
        if (result === "group" || result === "pending") summary.taiwan += 1;
        const text = {
          group: `淘寶/台灣單號 ${parsed.taiwanTracking} 已自動填入最近一筆未填單號的出貨`,
          pending: `淘寶/台灣單號 ${parsed.taiwanTracking} 已記到待確認出貨，確認時會自動帶入`,
          none: `淘寶/收到台灣單號 ${parsed.taiwanTracking}，但找不到 3 天內未填單號的出貨，請手動填入`
        }[result];
        if (text) inbox.log.push({ at: nowIso, message_ts: message.ts, type: "taiwan", text });
        if (result === "pending" || result === "group") {
          data = data || await readDataFile();
          if (stampUnassignedFromPending(data, inbox)) dataChanged = true;
        }
      }

      inbox.processed.push(message.hash);
    }

    data = data || await readDataFile();
    if (stampUnassignedFromPending(data, inbox)) dataChanged = true;

    if (dataChanged) {
      await backupCurrentDataFile();
      await writeDataFile({ ...data, version: data.version + 1 });
    }
    await writeInbox(inbox);
    return summary;
  });
}

app.post("/api/inbox/messages", requireInboxSecret, async (req, res) => {
  const raw = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!raw) return res.status(400).json({ ok: false, error: "INVALID_PAYLOAD" });
  const messages = raw
    .slice(0, 500)
    .filter((m) => m && typeof m.id === "string" && typeof m.text === "string")
    .map((m) => ({ id: m.id.slice(0, 6000), ts: String(m.ts || ""), sender: String(m.sender || ""), self: m.self === true, text: m.text.slice(0, 5000) }));
  try {
    const summary = await processInboxMessages(messages);
    await withWriteLock(async () => {
      const inbox = await readInbox();
      inbox.sync = {
        ok: true,
        detail: `剛送出 ${messages.length} 則`,
        conversation: String(req.body?.conversation || inbox.sync?.conversation || "").slice(0, 100),
        lastHeartbeatAt: new Date().toISOString()
      };
      await writeInbox(inbox);
    });
    return res.json({ ok: true, ...summary });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "INBOX_FAILED" });
  }
});

app.post("/api/inbox/heartbeat", requireInboxSecret, async (req, res) => {
  const ok = req.body?.ok !== false;
  const detail = String(req.body?.detail || "").trim().slice(0, 200);
  const conversation = String(req.body?.conversation || "").trim().slice(0, 100);
  const rawChannel = String(req.body?.channel || "").trim().toLowerCase();
  let channel = "taobao";
  let field = "sync";
  let name = "淘寶";
  if (rawChannel === "wechat") {
    channel = "wechat";
    field = "syncWechat";
    name = "微信";
  } else if (rawChannel === "line") {
    channel = "line";
    field = "syncLine";
    name = "LINE記事本";
  }
  try {
    const sync = await withWriteLock(async () => {
      const inbox = await readInbox();
      const entry = {
        ok,
        detail,
        conversation,
        lastHeartbeatAt: new Date().toISOString()
      };
      if (channel === "line") {
        entry.intervalSec = normalizeLineIntervalSec(req.body?.intervalSec);
      }
      inbox[field] = entry;
      await writeInbox(inbox);
      return inbox[field];
    });
    const staleMs = channel === "line" ? lineStaleMs(sync) : SYNC_STALE_MS;
    return res.json({ ok: true, channel, sync: buildSyncStatus(sync, name, staleMs) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "HEARTBEAT_FAILED" });
  }
});

async function handleInboundLabels(req, res) {
  const trackings = normalizeLabelTrackings(req.body?.trackings);
  if (!trackings.length) return res.status(400).json({ ok: false, error: "NO_TRACKINGS" });
  const source = String(req.body?.source || "wechat").trim().slice(0, 40) || "wechat";
  try {
    const result = await inboundLabelTrackings(trackings.slice(0, 200), source);
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "LABEL_INBOUND_FAILED" });
  }
}

app.post("/api/inbox/labels", requireInboxSecret, handleInboundLabels);
app.post("/api/order-tool/inbound-labels", requireAppAuth, handleInboundLabels);

function normalizeOrderSource(raw) {
  const source = String(raw || "").trim().replace(/[\r\n]+/g, " ").slice(0, 40);
  return source || "taobao";
}

function orderSourceLogPrefix(source) {
  if (source === "taobao") return "淘寶/訂單自動新增";
  if (source === "line-notebook") return "LINE/記事本自動新增";
  return `${source}/`;
}

async function addTaobaoOrders(ownerName, orders, source = "taobao") {
  return withWriteLock(async () => {
    const data = await readDataFile();
    const owner = data.friends.find((friend) => (friend.name || "").trim() === ownerName);
    if (!owner) return { ownerMissing: true };

    const index = buildServerTrackingIndex(data);
    const nowIso = new Date().toISOString();
    const added = [];
    const existing = [];

    orders.forEach(({ tracking, remark }) => {
      const key = tracking.toLowerCase();
      if (index.has(key)) {
        existing.push(tracking);
        return;
      }
      const parcel = {
        id: crypto.randomUUID(),
        tracking_id_china: tracking,
        remark,
        status: "pending_arrival",
        shipping_priority: "normal",
        weight_kg: 0,
        taiwan_parcel_group_id: null,
        created_at: nowIso,
        arrived_at_warehouse_time: null,
        shipped_to_taiwan_time: null
      };
      owner.parcels.push(parcel);
      index.set(key, [{ friend: owner, parcel }]);
      added.push({ tracking, remark });
    });

    if (added.length) {
      await backupCurrentDataFile();
      await writeDataFile({ ...data, version: data.version + 1 });
      const inbox = await readInbox();
      inbox.log.push({
        at: nowIso,
        message_ts: "",
        type: "orders",
        text: `${orderSourceLogPrefix(source)} ${added.length} 筆（${ownerName}）：${added.map((a) => `${a.tracking} ${a.remark}`.trim()).join("、")}`
      });
      await writeInbox(inbox);
    }
    return { added: added.length, existing: existing.length };
  });
}

app.post("/api/inbox/orders", requireInboxSecret, async (req, res) => {
  const ownerName = String(req.body?.owner || "").trim();
  const raw = Array.isArray(req.body?.orders) ? req.body.orders : null;
  if (!ownerName || !raw) return res.status(400).json({ ok: false, error: "INVALID_PAYLOAD" });
  const source = normalizeOrderSource(req.body?.source);
  const orders = raw
    .slice(0, 300)
    .map((o) => ({ tracking: String(o?.tracking || "").trim(), remark: String(o?.remark || "").trim().slice(0, 100) }))
    .filter((o) => /^[A-Za-z0-9]{6,40}$/.test(o.tracking));
  try {
    const result = await addTaobaoOrders(ownerName, orders, source);
    if (result.ownerMissing) return res.status(404).json({ ok: false, error: "OWNER_NOT_FOUND" });
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "ORDERS_FAILED" });
  }
});

app.get("/api/inbox/state", requireAppAuth, async (_req, res) => {
  try {
    const inbox = await readInbox();
    return res.json({
      ok: true,
      pending: inbox.pending,
      log: inbox.log.slice(-20),
      sync: buildSyncStatus(inbox.sync, "淘寶", SYNC_STALE_MS),
      syncWechat: buildSyncStatus(inbox.syncWechat, "微信", SYNC_STALE_MS),
      syncLine: buildSyncStatus(inbox.syncLine, "LINE記事本", lineStaleMs(inbox.syncLine))
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "READ_FAILED" });
  }
});

app.post("/api/inbox/pending/:id/resolve", requireAppAuth, async (req, res) => {
  const action = req.body?.action === "confirmed" ? "confirmed" : "dismissed";
  try {
    const found = await withWriteLock(async () => {
      const inbox = await readInbox();
      const target = inbox.pending.find((p) => p.id === req.params.id);
      if (!target) return false;
      inbox.pending = inbox.pending.filter((p) => p.id !== req.params.id);
      inbox.log.push({
        at: new Date().toISOString(),
        message_ts: target.message_ts,
        type: action,
        text: action === "confirmed" ? `已確認出貨 ${target.items.length} 筆` : `已略過出貨報價 ${target.items.length} 筆`
      });
      await writeInbox(inbox);
      return true;
    });
    if (!found) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: "WRITE_FAILED" });
  }
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

app.listen(PORT, "0.0.0.0", () => {
  ensureDataFile()
    .then(() => {
      console.log(`Order tool backend running on :${PORT}`);
      console.log("Listening host: 0.0.0.0");
      console.log(`Data file path: ${activeDataFilePath}`);
      if (!hasConfiguredAuth()) {
        console.warn("Auth is not fully configured. Set AUTH_USERNAME, AUTH_SESSION_SECRET, and AUTH_PASSWORD_HASH.");
      } else if (!AUTH_PASSWORD_HASH) {
        console.warn("Using AUTH_PASSWORD fallback. Prefer AUTH_PASSWORD_HASH for stronger security.");
      }
    })
    .catch((error) => {
      console.error("Data file initialization failed:", error);
    });
});

