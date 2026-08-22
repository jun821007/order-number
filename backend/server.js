const express = require("express");
const cors = require("cors");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");

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
    return callback(new Error("Not allowed by CORS"));
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
  return { friends, taiwan_parcel_groups: groups };
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

app.put("/api/order-tool/data", requireAppAuth, async (req, res) => {
  try {
    const payload = req.body?.data ?? req.body;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "INVALID_PAYLOAD" });
    }

    const saved = await writeDataFile(payload);
    return res.json(saved);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "WRITE_FAILED" });
  }
});

app.post("/api/order-tool/data", requireAppAuth, async (req, res) => {
  try {
    const payload = req.body?.data ?? req.body;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "INVALID_PAYLOAD" });
    }

    const saved = await writeDataFile(payload);
    return res.json(saved);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "WRITE_FAILED" });
  }
});

app.patch("/api/order-tool/data", requireAppAuth, async (req, res) => {
  try {
    const payload = req.body?.data ?? req.body;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "INVALID_PAYLOAD" });
    }

    const saved = await writeDataFile(payload);
    return res.json(saved);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "WRITE_FAILED" });
  }
});


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

