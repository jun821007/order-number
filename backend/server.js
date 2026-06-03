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
  const parsed = JSON.parse((raw || "{}").replace(/^﻿/, ""));
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
