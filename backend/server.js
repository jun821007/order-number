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

function normalizeDataShape(raw) {
  const friends = Array.isArray(raw?.friends) ? raw.friends : [];
  const groups = Array.isArray(raw?.taiwan_parcel_groups) ? raw.taiwan_parcel_groups : [];
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

app.listen(PORT, () => {
  ensureDataFile()
    .then(() => {
      console.log(`Order tool backend running on :${PORT}`);
      console.log(`Data file path: ${activeDataFilePath}`);
    })
    .catch((error) => {
      console.error("Data file initialization failed:", error);
    });
});
