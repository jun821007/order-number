const express = require("express");
const cors = require("cors");
const fs = require("node:fs/promises");
const path = require("node:path");

const app = express();
const PORT = process.env.PORT || 3100;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "storage");
const CONFIGURED_DATA_FILE_PATH = process.env.DATA_FILE_PATH || path.join(DATA_DIR, "data.json");
const FALLBACK_DATA_FILE_PATH = path.join(__dirname, "storage", "data.json");
let activeDataFilePath = CONFIGURED_DATA_FILE_PATH;

const emptyData = { friends: [], taiwan_parcel_groups: [] };

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

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

app.get("/api/order-tool/data", async (_req, res) => {
  try {
    const data = await readDataFile();
    return res.json(data);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "READ_FAILED" });
  }
});

app.put("/api/order-tool/data", async (req, res) => {
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

app.post("/api/order-tool/data", async (req, res) => {
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

app.patch("/api/order-tool/data", async (req, res) => {
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

function dedupeParcelItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const name = (item.friend_name || "").trim();
    const remark = (item.remark || "").trim();
    if (!remark) continue;
    const key = `${name}\0${remark}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ friend_name: name, remark });
  }
  return out;
}

function buildShippedTracks(data, days) {
  const groupById = new Map();
  for (const group of data.taiwan_parcel_groups || []) {
    groupById.set(group.id, group);
  }

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
        };

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
            parcel_items: dedupeParcelItems([parcelLine]),
          });
          continue;
        }

        const prevTs = Date.parse(prev.shipped_at || "");
        const nextTs = Date.parse(shippedAt || "");
        const keepNewer = Number.isFinite(nextTs) && (!Number.isFinite(prevTs) || nextTs >= prevTs);
        const base = keepNewer ? { ...prev, shipped_at: shippedAt || prev.shipped_at } : { ...prev };
        if (keepNewer && shippingAddress) base.shipping_address = shippingAddress;
        if (!base.shipping_address && shippingAddress) base.shipping_address = shippingAddress;

        byTracking.set(trackingNumber, {
          ...base,
          parcel_items: dedupeParcelItems(mergeParcelItems(prev.parcel_items, parcelLine.friend_name, parcelLine.remark)),
        });
      }
    }
  }

  const items = [...byTracking.values()].sort((a, b) => Date.parse(b.shipped_at || 0) - Date.parse(a.shipped_at || 0));
  return items;
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
    })
    .catch((error) => {
      console.error("Data file initialization failed:", error);
    });
});

