const express = require("express");
const cors = require("cors");
const fs = require("node:fs/promises");
const path = require("node:path");

const app = express();
const PORT = process.env.PORT || 3100;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "storage");
const dataFilePath = process.env.DATA_FILE_PATH || path.join(DATA_DIR, "data.json");
const emptyData = { friends: [], taiwan_parcel_groups: [] };

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

function normalizeDataShape(raw) {
  const friends = Array.isArray(raw?.friends) ? raw.friends : [];
  const groups = Array.isArray(raw?.taiwan_parcel_groups) ? raw.taiwan_parcel_groups : [];
  return { friends, taiwan_parcel_groups: groups };
}

async function ensureDataFile() {
  try {
    await fs.access(dataFilePath);
  } catch {
    await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
    await fs.writeFile(dataFilePath, JSON.stringify(emptyData, null, 2), "utf8");
  }
}

async function readDataFile() {
  await ensureDataFile();
  const raw = await fs.readFile(dataFilePath, "utf8");
  const parsed = JSON.parse((raw || "{}").replace(/^\uFEFF/, ""));
  return normalizeDataShape(parsed);
}

async function writeDataFile(data) {
  await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
  const normalized = normalizeDataShape(data);
  const tempPath = `${dataFilePath}.tmp`;

  await fs.writeFile(tempPath, JSON.stringify(normalized, null, 2), "utf8");
  await fs.rename(tempPath, dataFilePath);

  return normalized;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "order-tool-backend" });
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

app.listen(PORT, async () => {
  await ensureDataFile();
  console.log(`Order tool backend running on :${PORT}`);
});

