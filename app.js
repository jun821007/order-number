const EMPTY_DATA = { friends: [], taiwan_parcel_groups: [] };

const rawConfig = window.ORDER_TOOL_CONFIG || {};
const backendConfig = {
  baseUrl: (rawConfig.backend?.baseUrl || "").trim(),
  loadPath: rawConfig.backend?.loadPath || "/api/order-tool/data",
  savePath: rawConfig.backend?.savePath || "/api/order-tool/data",
  saveMethod: rawConfig.backend?.saveMethod || "PUT",
  responseDataField: rawConfig.backend?.responseDataField || "",
  requestDataField: rawConfig.backend?.requestDataField || "",
  headers: rawConfig.backend?.headers || {}
};

const els = {
  globalTrackingSearch: document.getElementById("globalTrackingSearch"),
  friendList: document.getElementById("friendList"),
  friendListToggleArea: document.getElementById("friendListToggleArea"),
  friendListStateText: document.getElementById("friendListStateText"),
  friendListBody: document.getElementById("friendListBody"),
  addFriendBtn: document.getElementById("addFriendBtn"),
  backHomeBtn: document.getElementById("backHomeBtn"),
  emptyState: document.getElementById("emptyState"),
  friendPanel: document.getElementById("friendPanel"),

  addParcelCard: document.getElementById("addParcelCard"),
  addParcelBody: document.getElementById("addParcelBody"),
  bulkInput: document.getElementById("bulkInput"),
  bulkFriendSelect: document.getElementById("bulkFriendSelect"),
  bulkAddBtn: document.getElementById("bulkAddBtn"),

  inboundCard: document.getElementById("inboundCard"),
  inboundBody: document.getElementById("inboundBody"),
  bulkInboundInput: document.getElementById("bulkInboundInput"),
  bulkInboundPriority: document.getElementById("bulkInboundPriority"),
  bulkInboundBtn: document.getElementById("bulkInboundBtn"),
  copyBulkInboundResultBtn: document.getElementById("copyBulkInboundResultBtn"),
  bulkInboundResult: document.getElementById("bulkInboundResult"),

  shipCard: document.getElementById("shipCard"),
  shipBody: document.getElementById("shipBody"),
  bulkShipInput: document.getElementById("bulkShipInput"),
  bulkShipTaiwanInput: document.getElementById("bulkShipTaiwanInput"),
  bulkShipBtn: document.getElementById("bulkShipBtn"),
  copyBulkShipResultBtn: document.getElementById("copyBulkShipResultBtn"),
  bulkShipResult: document.getElementById("bulkShipResult"),

  searchInput: document.getElementById("searchInput"),
  ownerFilter: document.getElementById("ownerFilter"),
  statusFilter: document.getElementById("statusFilter"),
  priorityFilter: document.getElementById("priorityFilter"),
  selectAll: document.getElementById("selectAll"),
  selectAllMobile: document.getElementById("selectAllMobile"),
  selectedCountText: document.getElementById("selectedCountText"),
  parcelTbody: document.getElementById("parcelTbody"),
  parcelCardList: document.getElementById("parcelCardList"),
  parcelCountText: document.getElementById("parcelCountText"),
  markArrivedBtn: document.getElementById("markArrivedBtn"),
  markShippedBtn: document.getElementById("markShippedBtn"),
  copyChinaBtn: document.getElementById("copyChinaBtn"),
  copyChinaRemarkBtn: document.getElementById("copyChinaRemarkBtn"),
  copyTaiwanBtn: document.getElementById("copyTaiwanBtn"),

  shippedTitle: document.getElementById("shippedTitle"),
  shippedTaiwanSearch: document.getElementById("shippedTaiwanSearch"),
  shippedSummaryList: document.getElementById("shippedSummaryList"),

  persistenceBadge: document.getElementById("persistenceBadge"),
  friendMenuBtn: document.getElementById("friendMenuBtn"),
  sidebar: document.getElementById("sidebar"),
  sidebarBackdrop: document.getElementById("sidebarBackdrop"),
  toast: document.getElementById("toast")
};

const state = {
  data: { ...EMPTY_DATA },
  selectedFriendId: null,
  bulkTargetFriendId: "",
  selectedParcelIds: new Set(),
  saveQueue: Promise.resolve(),
  shippedCollapsed: true,
  friendListCollapsed: true,
  addParcelCollapsed: true,
  inboundCollapsed: true,
  shipCollapsed: true,
  tableOwnerFilter: "all",
  bulkInboundCopyText: "",
  bulkShipCopyText: "",
  sidebarMenuOpen: false
};

const STATUS_LABEL = {
  pending_arrival: "未到集運倉",
  arrived_at_warehouse: "已到集運倉",
  shipped_to_taiwan: "已出轉運台灣"
};

function buildStatusOptions(selected) {
  return ["pending_arrival", "arrived_at_warehouse", "shipped_to_taiwan"]
    .map((value) => `<option value="${value}" ${value === selected ? "selected" : ""}>${STATUS_LABEL[value]}</option>`)
    .join("");
}

function getStatusSelectClass(status) {
  return `status-select status-select-${status}`;
}

function parseTaiwanTrackingIds(raw) {
  const lf = String.fromCharCode(10);
  const cr = String.fromCharCode(13);
  const normalized = (raw || "")
    .replaceAll("，", ",")
    .replaceAll(cr, lf);
  const parts = normalized
    .split(",")
    .flatMap((part) => part.split(lf))
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

function formatTaiwanTrackingDisplay(raw) {
  return parseTaiwanTrackingIds(raw).join(String.fromCharCode(10));
}

const PRIORITY_LABEL = {
  normal: "一般",
  priority: "急"
};

function uid() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function formatTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("zh-TW", { hour12: false });
}

function formatDateOnly(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("zh-TW");
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => els.toast.classList.add("hidden"), 1700);
}

function updatePersistenceBadge() {
  if (!els.persistenceBadge) return;
  els.persistenceBadge.classList.add("hidden");
}

function updateFriendListCollapseUI() {
  els.friendListBody.classList.toggle("hidden", state.friendListCollapsed);
  els.friendListStateText.textContent = state.friendListCollapsed ? "展開" : "收起";
}

function updateSectionCollapseUI() {
  els.addParcelBody.classList.toggle("hidden", state.addParcelCollapsed);
  els.inboundBody.classList.toggle("hidden", state.inboundCollapsed);
  els.shipBody.classList.toggle("hidden", state.shipCollapsed);
}

function updateBulkAddAvailability() {
  els.bulkAddBtn.disabled = !state.bulkTargetFriendId;
}

function shouldUseSidebarDrawer() {
  return window.matchMedia("(max-width: 1100px), (min-width: 900px) and (max-width: 1366px) and (orientation: landscape)").matches;
}

function isMobileView() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function updateSidebarMenuUI() {
  const useDrawer = shouldUseSidebarDrawer();
  if (!els.sidebar || !els.sidebarBackdrop) return;

  if (!useDrawer) state.sidebarMenuOpen = false;
  els.sidebar.classList.toggle("open", useDrawer && state.sidebarMenuOpen);
  els.sidebarBackdrop.classList.toggle("hidden", !(useDrawer && state.sidebarMenuOpen));
}

function closeSidebarMenu() {
  if (!state.sidebarMenuOpen) return;
  state.sidebarMenuOpen = false;
  updateSidebarMenuUI();
}

function getEndpoint(path) {
  if (!backendConfig.baseUrl) return "";
  return `${backendConfig.baseUrl.replace(/\/$/, "")}${path}`;
}

function resolvePayloadData(payload, fieldName) {
  if (!fieldName) return payload;
  return payload?.[fieldName];
}

function buildRequestBody(data, fieldName) {
  if (!fieldName) return data;
  return { [fieldName]: data };
}

function normalizeDataShape(raw) {
  const friends = Array.isArray(raw?.friends) ? raw.friends : [];
  const groups = Array.isArray(raw?.taiwan_parcel_groups) ? raw.taiwan_parcel_groups : [];
  return { friends, taiwan_parcel_groups: groups };
}

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast("已複製");
  } catch {
    toast("複製失敗，請手動複製");
  }
}

async function loadFromBackend() {
  const url = getEndpoint(backendConfig.loadPath);
  if (!url) throw new Error("請先設定 backend.baseUrl");
  const response = await fetch(url, { method: "GET", headers: backendConfig.headers });
  if (!response.ok) throw new Error(`讀取失敗(${response.status})`);
  const json = await response.json();
  return normalizeDataShape(resolvePayloadData(json, backendConfig.responseDataField));
}

async function saveToBackend() {
  const url = getEndpoint(backendConfig.savePath);
  if (!url) throw new Error("請先設定 backend.baseUrl");

  const payload = buildRequestBody(state.data, backendConfig.requestDataField);
  const response = await fetch(url, {
    method: backendConfig.saveMethod,
    headers: {
      "Content-Type": "application/json",
      ...backendConfig.headers
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) throw new Error(`儲存失敗(${response.status})`);
}

function enqueuePersist() {
  state.saveQueue = state.saveQueue.then(async () => {
    await saveToBackend();
  }).catch((error) => {
    console.error(error);
    toast("後端儲存失敗，請稍後重試");
  });
}

function getFriend() {
  return state.data.friends.find((f) => f.id === state.selectedFriendId) || null;
}

function findParcelOwnerById(parcelId) {
  for (const friend of state.data.friends) {
    const parcel = friend.parcels.find((p) => p.id === parcelId);
    if (parcel) return { friend, parcel };
  }
  return null;
}

function getScopeFriends() {
  if (state.tableOwnerFilter === "all") return state.data.friends;
  return state.data.friends.filter((f) => f.id === state.tableOwnerFilter);
}

function ownerCode(name) {
  const t = (name || "").trim();
  if (!t) return "?";
  const m = t.match(/[A-Za-z0-9]/);
  return m ? m[0].toUpperCase() : t[0];
}

function buildTrackingIndex() {
  const map = new Map();
  state.data.friends.forEach((friend) => {
    friend.parcels.forEach((parcel) => {
      const key = (parcel.tracking_id_china || "").toLowerCase();
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ friend, parcel });
    });
  });
  return map;
}

function cleanupTaiwanGroups() {
  const existingParcelIds = new Set();
  state.data.friends.forEach((friend) => friend.parcels.forEach((p) => existingParcelIds.add(p.id)));
  state.data.taiwan_parcel_groups.forEach((group) => {
    group.china_tracking_ids = group.china_tracking_ids.filter((id) => existingParcelIds.has(id));
  });
  state.data.taiwan_parcel_groups = state.data.taiwan_parcel_groups.filter((g) => g.china_tracking_ids.length > 0);
}

function getTaiwanGroupById(id) {
  return state.data.taiwan_parcel_groups.find((g) => g.id === id) || null;
}

function getTaiwanIdForParcel(parcel) {
  if (!parcel.taiwan_parcel_group_id) return "";
  return getTaiwanGroupById(parcel.taiwan_parcel_group_id)?.tracking_id_taiwan || "";
}

function upsertTaiwanGroupByTracking(trackingId) {
  let group = state.data.taiwan_parcel_groups.find((g) => g.tracking_id_taiwan === trackingId);
  if (!group) {
    group = {
      id: uid(),
      tracking_id_taiwan: trackingId,
      china_tracking_ids: [],
      total_weight_kg: 0,
      created_at: nowIso()
    };
    state.data.taiwan_parcel_groups.push(group);
  }
  return group;
}

function linkParcelToTaiwanGroup(parcelId, groupId) {
  state.data.taiwan_parcel_groups.forEach((group) => {
    group.china_tracking_ids = group.china_tracking_ids.filter((id) => id !== parcelId);
  });
  const target = getTaiwanGroupById(groupId);
  if (target && !target.china_tracking_ids.includes(parcelId)) target.china_tracking_ids.push(parcelId);
}

function recalcGroupWeights() {
  const parcels = new Map();
  state.data.friends.forEach((f) => f.parcels.forEach((p) => parcels.set(p.id, p)));
  state.data.taiwan_parcel_groups.forEach((group) => {
    group.total_weight_kg = group.china_tracking_ids.reduce((sum, id) => sum + (parcels.get(id)?.weight_kg || 0), 0);
  });
}

function persistAndRender(message) {
  cleanupTaiwanGroups();
  recalcGroupWeights();
  enqueuePersist();
  render();
  if (message) toast(message);
}

function getFilteredFriends() {
  const keyword = (els.globalTrackingSearch.value || "").trim().toLowerCase();
  if (!keyword) return [...state.data.friends];

  return state.data.friends.filter((friend) => {
    const friendName = (friend.name || "").toLowerCase();
    const receiptName = (friend.receipt_info?.name || "").toLowerCase();
    if (friendName.includes(keyword) || receiptName.includes(keyword)) return true;
    return friend.parcels.some((parcel) => {
      const china = (parcel.tracking_id_china || "").toLowerCase();
      const tw = getTaiwanIdForParcel(parcel).toLowerCase();
      return china.includes(keyword) || tw.includes(keyword);
    });
  });
}

function editFriendInfo(friendId) {
  const friend = state.data.friends.find((f) => f.id === friendId);
  if (!friend) return;
  const old = friend.receipt_info || { name: "", phone: "", address: "", id_number: "" };
  const name = prompt("收件姓名：", old.name || "");
  if (name === null) return;
  const phone = prompt("收件電話：", old.phone || "");
  if (phone === null) return;
  const address = prompt("收件地址：", old.address || "");
  if (address === null) return;
  const idNumber = prompt("身分證字號：", old.id_number || "");
  if (idNumber === null) return;

  friend.receipt_info = { name: name.trim(), phone: phone.trim(), address: address.trim(), id_number: idNumber.trim() };
  persistAndRender("已更新朋友資訊");
}

function copyFriendInfo(friendId) {
  const friend = state.data.friends.find((f) => f.id === friendId);
  if (!friend) return;
  const r = friend.receipt_info || { name: "", phone: "", address: "" };
  copyText(`姓名: ${r.name || "-"}\n電話: ${r.phone || "-"}\n地址: ${r.address || "-"}`);
}

function deleteFriend(friendId) {
  const target = state.data.friends.find((f) => f.id === friendId);
  if (!target) return;
  if (!confirm(`確定刪除朋友「${target.name}」與其全部單號？`)) return;

  state.data.friends = state.data.friends.filter((f) => f.id !== friendId);
  state.selectedParcelIds.clear();
  if (state.selectedFriendId === friendId) state.selectedFriendId = state.data.friends[0]?.id || null;
  if (state.bulkTargetFriendId === friendId) state.bulkTargetFriendId = "";

  persistAndRender("已刪除朋友");
}

function renderFriendList() {
  const friends = getFilteredFriends();
  els.friendList.innerHTML = "";

  if (friends.length === 0) {
    const li = document.createElement("li");
    li.className = "friend-item";
    li.textContent = state.data.friends.length ? "找不到符合單號的朋友" : "尚未建立朋友";
    els.friendList.appendChild(li);
    return;
  }

  friends.forEach((friend) => {
    const selected = friend.id === state.selectedFriendId;
    const r = friend.receipt_info || { name: "", phone: "", address: "", id_number: "" };
    const hasInfo = Boolean((r.name || r.phone || r.address || r.id_number || "").trim());

    const li = document.createElement("li");
    li.className = `friend-item ${selected ? "active" : ""}`;
    li.innerHTML = `
      <div class="friend-item-header">
        <div class="friend-item-name" data-friend-select="${friend.id}">${friend.name}</div>
        <div class="button-row tight">
          <button class="btn small" data-friend-edit="${friend.id}">${hasInfo ? "修改資訊" : "新增資訊"}</button>
          <button class="btn small" data-friend-copy="${friend.id}">複製資訊</button>
          <button class="btn danger small" data-friend-delete="${friend.id}">刪除</button>
        </div>
      </div>
      ${selected ? `<div class="friend-inline-info"><div>姓名：${r.name || "-"}</div><div>電話：${r.phone || "-"}</div><div>地址：${r.address || "-"}</div><div>身分證字號：${r.id_number || "-"}</div></div>` : ""}
    `;
    els.friendList.appendChild(li);
  });

  els.friendList.querySelectorAll("[data-friend-select]").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedFriendId = el.getAttribute("data-friend-select");
      state.selectedParcelIds.clear();
      closeSidebarMenu();
      render();
    });
  });

  els.friendList.querySelectorAll("[data-friend-edit]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      editFriendInfo(btn.getAttribute("data-friend-edit"));
    });
  });

  els.friendList.querySelectorAll("[data-friend-copy]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      copyFriendInfo(btn.getAttribute("data-friend-copy"));
    });
  });

  els.friendList.querySelectorAll("[data-friend-delete]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteFriend(btn.getAttribute("data-friend-delete"));
    });
  });
}

function renderFriendSelects() {
  const previousBulk = state.bulkTargetFriendId;
  const previousOwnerFilter = state.tableOwnerFilter;

  const fill = (selectEl, placeholder) => {
    selectEl.innerHTML = `<option value="">${placeholder}</option>`;
    state.data.friends.forEach((friend) => {
      const opt = document.createElement("option");
      opt.value = friend.id;
      opt.textContent = friend.name;
      selectEl.appendChild(opt);
    });
  };

  fill(els.bulkFriendSelect, "請先選擇朋友");

  els.ownerFilter.innerHTML = '<option value="all">全部件主</option>';
  state.data.friends.forEach((friend) => {
    const opt = document.createElement("option");
    opt.value = friend.id;
    opt.textContent = friend.name;
    els.ownerFilter.appendChild(opt);
  });

  if (state.data.friends.some((f) => f.id === previousBulk)) {
    state.bulkTargetFriendId = previousBulk;
    els.bulkFriendSelect.value = previousBulk;
  } else {
    state.bulkTargetFriendId = "";
  }

  if (previousOwnerFilter === "all" || state.data.friends.some((f) => f.id === previousOwnerFilter)) {
    state.tableOwnerFilter = previousOwnerFilter;
  } else {
    state.tableOwnerFilter = "all";
  }
  els.ownerFilter.value = state.tableOwnerFilter;

  updateBulkAddAvailability();
}

function addFriend() {
  const name = prompt("朋友名稱：");
  if (!name) return;
  state.data.friends.push({
    id: uid(),
    name: name.trim(),
    receipt_info: { name: "", phone: "", address: "", id_number: "" },
    parcels: []
  });
  state.selectedFriendId = state.data.friends[state.data.friends.length - 1].id;
  persistAndRender("已新增朋友");
}

function addBulkParcels() {
  const friend = state.data.friends.find((f) => f.id === state.bulkTargetFriendId);
  if (!friend) return toast("請先選擇朋友");

  const lines = els.bulkInput.value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return toast("請先輸入至少一筆單號");

  const trackingOwnerMap = new Map();
  state.data.friends.forEach((f) => {
    f.parcels.forEach((parcel) => {
      const key = (parcel.tracking_id_china || "").toLowerCase();
      if (!key || trackingOwnerMap.has(key)) return;
      trackingOwnerMap.set(key, f.name || "-");
    });
  });

  const batchSeen = new Set();
  const duplicated = [];
  let inserted = 0;

  lines.forEach((line) => {
    const [trackingRaw, ...remarkParts] = line.split(/\s+/);
    const tracking = (trackingRaw || "").trim();
    const key = tracking.toLowerCase();
    if (!tracking) return;

    if (batchSeen.has(key)) {
      duplicated.push(`${tracking}（本次重複）`);
      return;
    }
    batchSeen.add(key);

    if (trackingOwnerMap.has(key)) {
      duplicated.push(`${tracking}（已存在：${trackingOwnerMap.get(key)}）`);
      return;
    }

    friend.parcels.push({
      id: uid(),
      tracking_id_china: tracking,
      remark: remarkParts.join(" "),
      status: "pending_arrival",
      shipping_priority: "normal",
      weight_kg: 0,
      taiwan_parcel_group_id: null,
      created_at: nowIso(),
      arrived_at_warehouse_time: null,
      shipped_to_taiwan_time: null
    });
    trackingOwnerMap.set(key, friend.name || "-");
    inserted += 1;
  });

  if (!inserted) {
    if (duplicated.length) {
      const preview = duplicated.slice(0, 5).join("、");
      return toast(`沒有新增，單號重複：${preview}${duplicated.length > 5 ? "..." : ""}`);
    }
    return toast("沒有新增資料（可能都重複）");
  }

  state.selectedFriendId = friend.id;
  els.bulkInput.value = "";
  persistAndRender(`已新增 ${inserted} 筆${duplicated.length ? `，略過重複 ${duplicated.length} 筆` : ""}`);
}

function runBulkInbound() {
  const lines = els.bulkInboundInput.value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return toast("請先輸入批量入庫資料");

  const priority = els.bulkInboundPriority.value || "normal";
  const trackingIndex = buildTrackingIndex();
  const now = nowIso();

  const processed = [];
  const invalid = [];
  const missing = [];

  lines.forEach((line) => {
    if (/^合計|^合计|^total/i.test(line.replace(/\s+/g, ""))) return;
    const match = line.match(/^([0-9]+(?:\.[0-9]+)?)\s+([A-Za-z0-9]+)$/);
    if (!match) return invalid.push(line);

    const weight = Number.parseFloat(match[1]);
    const tracking = match[2];
    const entries = trackingIndex.get(tracking.toLowerCase()) || [];

    if (!entries.length) {
      missing.push(tracking);
      return;
    }

    entries.forEach(({ friend, parcel }) => {
      parcel.weight_kg = Number.isFinite(weight) ? weight : parcel.weight_kg;
      parcel.status = "arrived_at_warehouse";
      parcel.shipping_priority = priority;
      parcel.arrived_at_warehouse_time = now;
      parcel.shipped_to_taiwan_time = null;
      if (parcel.taiwan_parcel_group_id) {
        linkParcelToTaiwanGroup(parcel.id, "");
        parcel.taiwan_parcel_group_id = null;
      }
      processed.push(`${Number(parcel.weight_kg || 0).toFixed(1)} ${parcel.tracking_id_china} ${ownerCode(friend.name)}`);
    });
  });

  const output = [];
  if (processed.length) {
    output.push(processed.join("\n"));
    output.push(`\n合計 ${processed.length} 件`);
  }
  if (missing.length) output.push(`\n單號未key，無法帶入：${missing.join(", ")}`);
  if (invalid.length) output.push(`\n格式錯誤：\n${invalid.join("\n")}`);

  els.bulkInboundResult.textContent = output.join("\n").trim() || "沒有可處理資料";
  state.bulkInboundCopyText = processed.join("\n");

  if (processed.length) {
    persistAndRender(`已批量入庫 ${processed.length} 件${missing.length ? `，未key ${missing.length} 件` : ""}`);
  } else {
    render();
    if (missing.length) toast(`有 ${missing.length} 筆單號未key，無法帶入`);
  }
}

function runBulkShip() {
  const lines = els.bulkShipInput.value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return toast("請先輸入批量出轉運資料");

  const twList = parseTaiwanTrackingIds(els.bulkShipTaiwanInput.value || "");
  const batchTracking = twList.length ? twList.join("\n") : `BATCH-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
  const group = upsertTaiwanGroupByTracking(batchTracking);
  const trackingIndex = buildTrackingIndex();
  const now = nowIso();

  const processed = [];
  const notFound = [];
  const invalid = [];

  lines.forEach((line) => {
    if (/^合計|^合计|^total/i.test(line.replace(/\s+/g, ""))) return;
    const match = line.match(/^([0-9]+(?:\.[0-9]+)?)\s+([A-Za-z0-9]+)$/);
    if (!match) return invalid.push(line);

    const weight = Number.parseFloat(match[1]);
    const tracking = match[2];
    const entries = trackingIndex.get(tracking.toLowerCase()) || [];
    if (!entries.length) return notFound.push(tracking);

    entries.forEach(({ friend, parcel }) => {
      parcel.weight_kg = Number.isFinite(weight) ? weight : parcel.weight_kg;
      parcel.status = "shipped_to_taiwan";
      parcel.taiwan_parcel_group_id = group.id;
      parcel.shipped_to_taiwan_time = now;
      linkParcelToTaiwanGroup(parcel.id, group.id);
      processed.push(`${Number(parcel.weight_kg || 0).toFixed(1)} ${parcel.tracking_id_china} ${ownerCode(friend.name)}`);
    });
  });

  const output = [];
  if (processed.length) {
    output.push(processed.join("\n"));
    output.push(`\n合計 ${processed.length} 件`);
  }
  if (notFound.length) output.push(`\n找不到單號：${notFound.join(", ")}`);
  if (invalid.length) output.push(`\n格式錯誤：\n${invalid.join("\n")}`);

  els.bulkShipResult.textContent = output.join("\n").trim() || "沒有可處理資料";
  state.bulkShipCopyText = processed.join("\n");

  if (processed.length) {
    persistAndRender(`已批量出轉運 ${processed.length} 件`);
  } else {
    render();
  }
}

function getFilteredParcels(friend) {
  const keyword = els.searchInput.value.trim().toLowerCase();
  const status = els.statusFilter.value;
  const priority = els.priorityFilter.value;
  const ownerName = (friend.name || "").toLowerCase();
  const receiptName = (friend.receipt_info?.name || "").toLowerCase();

  return friend.parcels.filter((parcel) => {
    const tw = getTaiwanIdForParcel(parcel).toLowerCase();
    const inKeyword =
      !keyword ||
      parcel.tracking_id_china.toLowerCase().includes(keyword) ||
      (parcel.remark || "").toLowerCase().includes(keyword) ||
      tw.includes(keyword) ||
      ownerName.includes(keyword) ||
      receiptName.includes(keyword);
    const inStatus = !status || parcel.status === status;
    const inPriority = !priority || parcel.shipping_priority === priority;
    return inKeyword && inStatus && inPriority;
  });
}

function historySummary(parcel) {
  const arr = [];
  if (parcel.arrived_at_warehouse_time) arr.push(`入庫: ${formatTime(parcel.arrived_at_warehouse_time)}`);
  if (parcel.shipped_to_taiwan_time) arr.push(`出貨: ${formatTime(parcel.shipped_to_taiwan_time)}`);
  return arr.length ? arr.join(" | ") : `建立: ${formatTime(parcel.created_at)}`;
}

function compareByNewestShipped(a, b) {
  return new Date(b.shipped_to_taiwan_time || 0).getTime() - new Date(a.shipped_to_taiwan_time || 0).getTime();
}

function deleteParcel(parcelId) {
  const owner = findParcelOwnerById(parcelId);
  if (!owner) return;
  const { friend, parcel } = owner;
  if (!confirm(`\u78ba\u5b9a\u522a\u9664\u55ae\u865f ${parcel.tracking_id_china}\uff1f`)) return;
  friend.parcels = friend.parcels.filter((p) => p.id !== parcelId);
  state.selectedParcelIds.delete(parcelId);
  persistAndRender("\u5df2\u522a\u9664\u55ae\u865f");
}

function editParcel(parcelId) {
  const owner = findParcelOwnerById(parcelId);
  if (!owner) return;
  const { parcel } = owner;

  const remark = prompt("備註：", parcel.remark || "");
  if (remark === null) return;

  const statusInput = prompt("狀態(未到/已到/已出)：", parcel.status);
  const priorityInput = prompt("優先級(一般/急)：", PRIORITY_LABEL[parcel.shipping_priority] || "一般");
  const weightInput = prompt("重量(kg)：", String(parcel.weight_kg || 0));
  const twInput = prompt("台灣單號(可留空解除綁定；可用逗號分隔多個)：", getTaiwanIdForParcel(parcel));

  const statusMap = {
    未到: "pending_arrival",
    已到: "arrived_at_warehouse",
    已出: "shipped_to_taiwan",
    pending: "pending_arrival",
    arrived: "arrived_at_warehouse",
    shipped: "shipped_to_taiwan",
    pending_arrival: "pending_arrival",
    arrived_at_warehouse: "arrived_at_warehouse",
    shipped_to_taiwan: "shipped_to_taiwan"
  };

  const parsePriority = (v) => {
    const t = (v || "").trim().toLowerCase();
    if (["priority", "urgent", "急"].includes(t)) return "priority";
    if (["normal", "一般"].includes(t)) return "normal";
    return parcel.shipping_priority;
  };

  const nextStatus = statusMap[(statusInput || "").trim()] || parcel.status;
  const nextPriority = parsePriority(priorityInput);
  const nextWeight = Number.parseFloat(weightInput || "0");

  parcel.remark = remark.trim();
  parcel.status = nextStatus;
  parcel.shipping_priority = nextPriority;
  parcel.weight_kg = Number.isFinite(nextWeight) && nextWeight >= 0 ? nextWeight : parcel.weight_kg;

  if (parcel.status === "arrived_at_warehouse" && !parcel.arrived_at_warehouse_time) parcel.arrived_at_warehouse_time = nowIso();
  if (parcel.status === "shipped_to_taiwan" && !parcel.shipped_to_taiwan_time) parcel.shipped_to_taiwan_time = nowIso();

  const twList = parseTaiwanTrackingIds(twInput || "");
  const tw = twList.join("\n");
  if (!tw) {
    parcel.taiwan_parcel_group_id = null;
    linkParcelToTaiwanGroup(parcel.id, "");
  } else {
    const group = upsertTaiwanGroupByTracking(tw);
    parcel.status = "shipped_to_taiwan";
    parcel.taiwan_parcel_group_id = group.id;
    if (!parcel.shipped_to_taiwan_time) parcel.shipped_to_taiwan_time = nowIso();
    linkParcelToTaiwanGroup(parcel.id, group.id);
  }

  persistAndRender("已更新單號");
}

function updateParcelWeight(parcelId, nextWeight, message = "") {
  const owner = findParcelOwnerById(parcelId);
  if (!owner || !Number.isFinite(nextWeight) || nextWeight < 0) return false;
  owner.parcel.weight_kg = Number(nextWeight.toFixed(1));
  persistAndRender(message);
  return true;
}

function updateParcelStatus(parcelId, nextStatus, message = "") {
  const owner = findParcelOwnerById(parcelId);
  if (!owner || !STATUS_LABEL[nextStatus]) return false;

  const { parcel } = owner;
  parcel.status = nextStatus;

  if (nextStatus === "pending_arrival") {
    if (parcel.taiwan_parcel_group_id) {
      linkParcelToTaiwanGroup(parcel.id, "");
      parcel.taiwan_parcel_group_id = null;
    }
    parcel.shipped_to_taiwan_time = null;
  }

  if (nextStatus === "arrived_at_warehouse") {
    if (!parcel.arrived_at_warehouse_time) parcel.arrived_at_warehouse_time = nowIso();
    if (parcel.taiwan_parcel_group_id) {
      linkParcelToTaiwanGroup(parcel.id, "");
      parcel.taiwan_parcel_group_id = null;
    }
    parcel.shipped_to_taiwan_time = null;
  }

  if (nextStatus === "shipped_to_taiwan") {
    if (!parcel.shipped_to_taiwan_time) parcel.shipped_to_taiwan_time = nowIso();
  }

  persistAndRender(message);
  return true;
}

function updateSelectedCountUI() {
  if (!els.selectedCountText) return;
  els.selectedCountText.textContent = `已選 ${state.selectedParcelIds.size}`;
}

function buildParcelRow(parcel, ownerName, className = "") {
  const tr = document.createElement("tr");
  if (className) tr.className = className;
  const tw = formatTaiwanTrackingDisplay(getTaiwanIdForParcel(parcel));
  tr.innerHTML = `
    <td><input type="checkbox" data-parcel-id="${parcel.id}" ${state.selectedParcelIds.has(parcel.id) ? "checked" : ""}></td>
    <td><button class="link-btn" data-edit-id="${parcel.id}">${parcel.tracking_id_china}</button></td>
    <td>${parcel.remark || "-"}</td>
    <td>${ownerName || "-"}</td>
    <td><select class="${getStatusSelectClass(parcel.status)}" data-status-id="${parcel.id}">${buildStatusOptions(parcel.status)}</select></td>
    <td>${PRIORITY_LABEL[parcel.shipping_priority] || parcel.shipping_priority}</td>
    <td><input class="weight-input" type="number" min="0" step="0.1" value="${Number(parcel.weight_kg || 0).toFixed(1)}" data-weight-id="${parcel.id}"></td>
    <td><span class="tw-display">${tw || "-"}</span></td>
    <td>${historySummary(parcel)}</td>
    <td>
      <div class="button-row tight">
        <button class="btn small" data-copy-one="${parcel.id}">複製</button>
        <button class="btn danger small" data-delete-parcel="${parcel.id}">刪除</button>
      </div>
    </td>
  `;
  return tr;
}

function buildParcelCard(parcel, ownerName, className) {
  const tw = formatTaiwanTrackingDisplay(getTaiwanIdForParcel(parcel));
  const div = document.createElement("div");
  div.className = "parcel-card " + (className || "");
  div.innerHTML = `
    <label class="parcel-card-check"><input type="checkbox" data-parcel-id="${parcel.id}" ${state.selectedParcelIds.has(parcel.id) ? "checked" : ""}></label>
    <div class="parcel-card-body">
      <div class="parcel-card-tracking"><button class="link-btn" data-edit-id="${parcel.id}">${parcel.tracking_id_china}</button></div>
      <div class="parcel-card-meta">
        <span>${ownerName || "-"}</span>
        <select class="${getStatusSelectClass(parcel.status)}" data-status-id="${parcel.id}">${buildStatusOptions(parcel.status)}</select>
      </div>
      <div class="mobile-weight-editor">
        <label>重量(kg)</label>
        <input class="weight-input" type="number" min="0" step="0.1" value="${Number(parcel.weight_kg || 0).toFixed(1)}" data-weight-id="${parcel.id}">
      </div>
      ${parcel.remark ? '<div class="parcel-card-remark">' + parcel.remark + "</div>" : ""}
      ${tw ? '<div class="parcel-card-tw tw-display">台灣:\n' + tw + "</div>" : ""}
      <div class="parcel-card-date">${formatDateOnly(parcel.shipped_to_taiwan_time || parcel.arrived_at_warehouse_time || parcel.created_at)}</div>
      <div class="button-row tight">
        <button class="btn small" data-copy-one="${parcel.id}">複製</button>
        <button class="btn danger small" data-delete-parcel="${parcel.id}">刪除</button>
      </div>
    </div>
  `;
  return div;
}

function renderParcelRows() {
  const scopedRows = [];
  getScopeFriends().forEach((friend) => {
    getFilteredParcels(friend).forEach((parcel) => scopedRows.push({ friend, parcel }));
  });

  const activeRows = scopedRows.filter((row) => row.parcel.status !== "shipped_to_taiwan");
  const shippedRows = scopedRows
    .filter((row) => row.parcel.status === "shipped_to_taiwan")
    .sort((a, b) => compareByNewestShipped(a.parcel, b.parcel));
  const forceExpandShipped = els.statusFilter.value === "shipped_to_taiwan";
  const hideShipped = !forceExpandShipped && state.shippedCollapsed;

  els.parcelTbody.innerHTML = "";
  activeRows.forEach(({ friend, parcel }) => {
    els.parcelTbody.appendChild(buildParcelRow(parcel, friend.name));
  });

  if (shippedRows.length) {
    const tr = document.createElement("tr");
    tr.className = "collapse-row";
    tr.innerHTML = `<td colspan="10"><button class="collapse-toggle" data-toggle-shipped>${hideShipped ? "\u5c55\u958b" : "\u6536\u8d77"} \u5df2\u51fa\u8f49\u904b\u5230\u53f0\u7063 (${shippedRows.length})</button></td>`;
    els.parcelTbody.appendChild(tr);
    if (!hideShipped) {
      shippedRows.forEach(({ friend, parcel }) => {
        els.parcelTbody.appendChild(buildParcelRow(parcel, friend.name, "shipped-row"));
      });
    }
  }

  if (!scopedRows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="10">\u6c92\u6709\u7b26\u5408\u689d\u4ef6\u7684\u55ae\u865f</td>';
    els.parcelTbody.appendChild(tr);
  }

  els.parcelTbody.querySelectorAll("input[data-parcel-id]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = e.target.getAttribute("data-parcel-id");
      if (e.target.checked) state.selectedParcelIds.add(id);
      else state.selectedParcelIds.delete(id);
      updateSelectedCountUI();
    });
  });

  els.parcelTbody.querySelectorAll("select[data-status-id]").forEach((select) => {
    select.addEventListener("change", (e) => {
      const id = e.target.getAttribute("data-status-id");
      updateParcelStatus(id, e.target.value, "");
    });
  });

  els.parcelTbody.querySelectorAll("button[data-edit-id]").forEach((btn) => {
    btn.addEventListener("click", () => editParcel(btn.getAttribute("data-edit-id")));
  });

  els.parcelTbody.querySelectorAll("input[data-weight-id]").forEach((input) => {
    input.addEventListener("change", (e) => {
      const id = e.target.getAttribute("data-weight-id");
      const value = Number.parseFloat(e.target.value || "");
      if (!Number.isFinite(value) || value < 0) {
        toast("重量格式錯誤");
        renderParcelRows();
        return;
      }
      updateParcelWeight(id, value, "");
    });
  });

  els.parcelTbody.querySelectorAll("button[data-copy-one]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-copy-one");
      const owner = findParcelOwnerById(id);
      if (owner?.parcel) copyText(owner.parcel.tracking_id_china);
    });
  });

  els.parcelTbody.querySelectorAll("button[data-delete-parcel]").forEach((btn) => {
    btn.addEventListener("click", () => deleteParcel(btn.getAttribute("data-delete-parcel")));
  });

  const toggle = els.parcelTbody.querySelector("button[data-toggle-shipped]");
  if (toggle) {
    toggle.addEventListener("click", () => {
      state.shippedCollapsed = !state.shippedCollapsed;
      renderParcelRows();
    });
  }

  const selectableIds = activeRows.map((row) => row.parcel.id);
  els.selectAll.checked = selectableIds.length > 0 && selectableIds.every((id) => state.selectedParcelIds.has(id));
  if (els.selectAllMobile) els.selectAllMobile.checked = els.selectAll.checked;

  // Mobile card view
  if (els.parcelCardList) {
    els.parcelCardList.innerHTML = "";
    if (isMobileView()) {
      activeRows.forEach(({ friend, parcel }) => {
        els.parcelCardList.appendChild(buildParcelCard(parcel, friend.name));
      });
      if (shippedRows.length) {
        const divider = document.createElement("div");
        divider.className = "parcel-card-divider";
        divider.innerHTML = '<button class="collapse-toggle" data-toggle-shipped-mobile>' + (hideShipped ? "\u5c55\u958b" : "\u6536\u8d77") + ' \u5df2\u51fa\u8f49\u904b\u5230\u53f0\u7063 (' + shippedRows.length + ')</button>';
        els.parcelCardList.appendChild(divider);
        if (!hideShipped) {
          shippedRows.forEach(({ friend, parcel }) => {
            els.parcelCardList.appendChild(buildParcelCard(parcel, friend.name, "shipped-row"));
          });
        }
      }
      if (!scopedRows.length) {
        const empty = document.createElement("div");
        empty.className = "parcel-card-empty";
        empty.textContent = "\u6c92\u6709\u7b26\u5408\u689d\u4ef6\u7684\u55ae\u865f";
        els.parcelCardList.appendChild(empty);
      }
      els.parcelCardList.querySelectorAll("input[data-parcel-id]").forEach((cb) => {
        cb.addEventListener("change", (e) => {
          const id = e.target.getAttribute("data-parcel-id");
          if (e.target.checked) state.selectedParcelIds.add(id);
          else state.selectedParcelIds.delete(id);
          updateSelectedCountUI();
        });
      });
      els.parcelCardList.querySelectorAll("select[data-status-id]").forEach((select) => {
        select.addEventListener("change", (e) => {
          const id = e.target.getAttribute("data-status-id");
          updateParcelStatus(id, e.target.value, "");
        });
      });
      els.parcelCardList.querySelectorAll("button[data-edit-id]").forEach((btn) => {
        btn.addEventListener("click", () => editParcel(btn.getAttribute("data-edit-id")));
      });
      els.parcelCardList.querySelectorAll("input[data-weight-id]").forEach((input) => {
        input.addEventListener("change", (e) => {
          const id = e.target.getAttribute("data-weight-id");
          const value = Number.parseFloat(e.target.value || "");
          if (!Number.isFinite(value) || value < 0) {
            toast("重量格式錯誤");
            renderParcelRows();
            return;
          }
          updateParcelWeight(id, value, "");
        });
      });
      els.parcelCardList.querySelectorAll("button[data-copy-one]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-copy-one");
          const owner = findParcelOwnerById(id);
          if (owner?.parcel) copyText(owner.parcel.tracking_id_china);
        });
      });
      els.parcelCardList.querySelectorAll("button[data-delete-parcel]").forEach((btn) => {
        btn.addEventListener("click", () => deleteParcel(btn.getAttribute("data-delete-parcel")));
      });
      const mobileToggle = els.parcelCardList.querySelector("button[data-toggle-shipped-mobile]");
      if (mobileToggle) {
        mobileToggle.addEventListener("click", () => {
          state.shippedCollapsed = !state.shippedCollapsed;
          renderParcelRows();
        });
      }
    }
  }

  if (els.parcelCountText) els.parcelCountText.textContent = `\u76ee\u524d\u5171 ${scopedRows.length} \u7b46\u55ae\u865f`;
  updateSelectedCountUI();
}

function renderShippedSummary() {
  const NL = String.fromCharCode(10);
  const shippedRows = [];
  getScopeFriends().forEach((friend) => {
    friend.parcels
      .filter((p) => p.status === "shipped_to_taiwan")
      .forEach((parcel) => shippedRows.push({ friend, parcel }));
  });

  const scopeLabel = state.tableOwnerFilter === "all"
    ? "全部件主"
    : (state.data.friends.find((f) => f.id === state.tableOwnerFilter)?.name || "指定件主");
  els.shippedTitle.textContent = `${scopeLabel} 已轉出運包裹清單與總重量`;

  if (!els.shippedSummaryList) return;

  const keyword = (els.shippedTaiwanSearch?.value || "").trim().toLowerCase();
  const groupMap = new Map();

  shippedRows.forEach(({ friend, parcel }) => {
    const taiwanId = formatTaiwanTrackingDisplay(getTaiwanIdForParcel(parcel));
    if (!taiwanId) return;
    if (keyword && !taiwanId.toLowerCase().includes(keyword)) return;

    const shippedAt = parcel.shipped_to_taiwan_time || "";
    const ts = Number.isFinite(new Date(shippedAt).getTime()) ? new Date(shippedAt).getTime() : 0;

    if (!groupMap.has(taiwanId)) {
      groupMap.set(taiwanId, {
        taiwanId,
        latestTs: ts,
        latestDate: formatDateOnly(shippedAt),
        items: []
      });
    }

    const group = groupMap.get(taiwanId);
    if (ts >= group.latestTs) {
      group.latestTs = ts;
      group.latestDate = formatDateOnly(shippedAt);
    }

    group.items.push({
      weight: Number(parcel.weight_kg || 0),
      chinaTracking: parcel.tracking_id_china,
      ownerName: friend.name || "-",
      ts
    });
  });

  const groups = [...groupMap.values()].sort((a, b) => b.latestTs - a.latestTs);
  groups.forEach((group) => {
    group.items.sort((a, b) => {
      const ownerOrder = (a.ownerName || "").localeCompare((b.ownerName || ""), "zh-TW");
      if (ownerOrder !== 0) return ownerOrder;
      return b.ts - a.ts;
    });
  });

  els.shippedSummaryList.innerHTML = "";

  if (!groups.length) {
    els.shippedSummaryList.textContent = "目前沒有符合條件的已轉出資料。";
    return;
  }

  const formatWeightText = (value) => Number(value || 0).toFixed(1).replace(/\.0$/, "");
  const totalWeight = groups.reduce((sum, group) => {
    return sum + group.items.reduce((sub, item) => sub + item.weight, 0);
  }, 0);

  const totalEl = document.createElement("div");
  totalEl.className = "shipped-summary-total";
  totalEl.textContent = `合計重量: ${Number(totalWeight || 0).toFixed(1)}kg`;
  els.shippedSummaryList.appendChild(totalEl);

  groups.forEach((group) => {
    const detail = document.createElement("details");
    detail.className = "shipped-group";

    const summary = document.createElement("summary");
    summary.textContent = `台灣單號 ${group.taiwanId} | 日期 ${group.latestDate}`;
    detail.appendChild(summary);

    const groupWeight = group.items.reduce((sum, item) => sum + item.weight, 0);

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn small shipped-copy-btn";
    copyBtn.textContent = "複製此單號內容";
    copyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const lines = [
        `台灣單號 ${group.taiwanId} | 日期 ${group.latestDate}`,
        ...group.items.map((item) => `${item.weight.toFixed(1)} ${item.chinaTracking} ${item.ownerName}`)
      ];
      lines.push("");
      lines.push(`此單號合計重量: ${Number(groupWeight || 0).toFixed(1)}kg`);
      lines.push(`出貨時間: ${group.latestDate}`);
      copyText(lines.join(NL));
    });

    const ownerWeightMap = new Map();
    group.items.forEach((item) => {
      ownerWeightMap.set(item.ownerName, (ownerWeightMap.get(item.ownerName) || 0) + item.weight);
    });
    const ownerNames = [...ownerWeightMap.keys()];

    const tools = document.createElement("div");
    tools.className = "shipped-owner-tools";

    const ownerSelect = document.createElement("select");
    ownerNames.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      ownerSelect.appendChild(opt);
    });

    const ownerWeightInput = document.createElement("input");
    ownerWeightInput.type = "number";
    ownerWeightInput.min = "0";
    ownerWeightInput.step = "0.1";

    const feeInput = document.createElement("input");
    feeInput.type = "number";
    feeInput.min = "0";
    feeInput.step = "1";
    feeInput.placeholder = "輸入總運費";

    const syncOwnerWeight = () => {
      const selectedOwner = ownerSelect.value;
      const ownerWeight = ownerWeightMap.get(selectedOwner) || 0;
      ownerWeightInput.value = Number(ownerWeight || 0).toFixed(1);
    };
    syncOwnerWeight();
    ownerSelect.addEventListener("change", syncOwnerWeight);

    const copyOwnerBtn = document.createElement("button");
    copyOwnerBtn.type = "button";
    copyOwnerBtn.className = "btn small";
    copyOwnerBtn.textContent = "複製件主單號";
    copyOwnerBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const owner = ownerSelect.value;
      const ownerItems = group.items.filter((item) => item.ownerName === owner);
      if (!ownerItems.length) return toast("此件主沒有資料");
      copyText(ownerItems.map((item) => `${item.weight.toFixed(1)} ${item.chinaTracking} ${item.ownerName}`).join(NL));
    });

    const settleCopyBtn = document.createElement("button");
    settleCopyBtn.type = "button";
    settleCopyBtn.className = "btn small";
    settleCopyBtn.textContent = "結算複製";
    settleCopyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const owner = ownerSelect.value;
      const ownerItems = group.items.filter((item) => item.ownerName === owner);
      if (!ownerItems.length) return toast("此件主沒有資料");

      const totalFee = Number.parseFloat((feeInput.value || "").trim());
      if (!Number.isFinite(totalFee) || totalFee < 0) return toast("請先輸入總運費");

      const ownerWeight = Number.parseFloat((ownerWeightInput.value || "").trim());
      if (!Number.isFinite(ownerWeight) || ownerWeight < 0) return toast("件主總重格式錯誤");

      if (groupWeight <= 0) return toast("此包裹總重為 0，無法結算");

      const unitPrice = totalFee / groupWeight;
      const ownerFee = unitPrice * ownerWeight;
      const lines = ownerItems.map((item) => `${item.weight.toFixed(1)} ${item.chinaTracking} ${item.ownerName}`);
      lines.push(`總重${formatWeightText(ownerWeight)}kg`);
      lines.push(`運費台幣${totalFee}/總重${formatWeightText(groupWeight)} = *${unitPrice.toFixed(2)}*`);
      lines.push(`${unitPrice.toFixed(2)}*${formatWeightText(ownerWeight)} = *${ownerFee.toFixed(2)}*`);
      copyText(lines.join(NL));
    });

    tools.append("件主", ownerSelect, "件主總重", ownerWeightInput, "總運費", feeInput, copyOwnerBtn, settleCopyBtn);

    const ul = document.createElement("ul");
    ul.className = "shipped-group-items";

    let currentOwner = "";
    group.items.forEach((item) => {
      if (item.ownerName !== currentOwner) {
        currentOwner = item.ownerName;
        const ownerLi = document.createElement("li");
        ownerLi.className = "owner-divider";
        ownerLi.textContent = `【${currentOwner}】`;
        ul.appendChild(ownerLi);
      }
      const li = document.createElement("li");
      li.textContent = `${item.weight.toFixed(1)} ${item.chinaTracking} ${item.ownerName}`;
      ul.appendChild(li);
    });

    const footer = document.createElement("div");
    footer.className = "shipped-group-footer";
    footer.innerHTML = `此單號合計重量: ${Number(groupWeight || 0).toFixed(1)}kg<br>出貨時間: ${group.latestDate}`;

    detail.appendChild(copyBtn);
    detail.appendChild(tools);
    detail.appendChild(ul);
    detail.appendChild(footer);
    els.shippedSummaryList.appendChild(detail);
  });
}

function renderFriendPanel() {
  els.emptyState.classList.add("hidden");
  els.friendPanel.classList.remove("hidden");

  renderParcelRows();
  renderShippedSummary();
}

function render() {
  updateFriendListCollapseUI();
  updateSectionCollapseUI();
  updateSidebarMenuUI();
  renderFriendList();
  renderFriendSelects();
  renderFriendPanel();
}

function applyGlobalSearchFilter() {
  renderFriendList();
}

function markSelectedArrived() {
  const selected = [];
  state.data.friends.forEach((friend) => {
    friend.parcels.forEach((parcel) => {
      if (state.selectedParcelIds.has(parcel.id)) selected.push(parcel);
    });
  });
  if (!selected.length) return toast("\u8acb\u5148\u52fe\u9078\u55ae\u865f");

  const now = nowIso();
  selected.forEach((parcel) => {
    parcel.status = "arrived_at_warehouse";
    parcel.arrived_at_warehouse_time = now;
    parcel.shipped_to_taiwan_time = null;
    if (parcel.taiwan_parcel_group_id) {
      linkParcelToTaiwanGroup(parcel.id, "");
      parcel.taiwan_parcel_group_id = null;
    }
  });

  persistAndRender("\u5df2\u66f4\u65b0\u70ba\u5df2\u5230\u96c6\u904b\u5009");
}

function markSelectedShipped() {
  const selected = [];
  state.data.friends.forEach((friend) => {
    friend.parcels.forEach((parcel) => {
      if (state.selectedParcelIds.has(parcel.id)) selected.push(parcel);
    });
  });
  if (!selected.length) return toast("請先勾選單號");

  const hasPending = selected.some((parcel) => parcel.status === "pending_arrival");
  if (hasPending && !confirm("選取中包含『未到集運倉』單號，確定仍要改為已出轉運嗎？")) return;

  const trackingTaiwanRaw = prompt("輸入台灣單號(留空略過；可用逗號分隔多個)：") || "";
  const taiwanList = parseTaiwanTrackingIds(trackingTaiwanRaw);
  if (!taiwanList.length) return toast("已略過操作");

  const group = upsertTaiwanGroupByTracking(taiwanList.join(String.fromCharCode(10)));
  selected.forEach((parcel) => {
    parcel.status = "shipped_to_taiwan";
    parcel.taiwan_parcel_group_id = group.id;
    if (!parcel.shipped_to_taiwan_time) parcel.shipped_to_taiwan_time = nowIso();
    linkParcelToTaiwanGroup(parcel.id, group.id);
  });

  persistAndRender("已更新為已出轉運");
}

function copySelectedChina() {
  const text = [];
  state.data.friends.forEach((friend) => {
    friend.parcels.forEach((parcel) => {
      if (state.selectedParcelIds.has(parcel.id)) text.push(parcel.tracking_id_china);
    });
  });
  if (!text.length) return toast("\u6c92\u6709\u53ef\u8907\u88fd\u8cc7\u6599");
  copyText(text.join("\n"));
}

function copySelectedChinaWithRemark() {
  const text = [];
  state.data.friends.forEach((friend) => {
    friend.parcels.forEach((parcel) => {
      if (!state.selectedParcelIds.has(parcel.id)) return;
      const remark = (parcel.remark || "").trim();
      text.push(remark ? `${parcel.tracking_id_china} ${remark}` : parcel.tracking_id_china);
    });
  });
  if (!text.length) return toast("\u6c92\u6709\u53ef\u8907\u88fd\u8cc7\u6599");
  copyText(text.join("\n"));
}

function copySelectedTaiwan() {
  const taiwanIds = new Set();
  state.data.friends.forEach((friend) => {
    friend.parcels.forEach((parcel) => {
      if (!state.selectedParcelIds.has(parcel.id)) return;
      const tw = formatTaiwanTrackingDisplay(getTaiwanIdForParcel(parcel));
      parseTaiwanTrackingIds(tw).forEach((id) => taiwanIds.add(id));
    });
  });
  const text = [...taiwanIds].join("\n");
  if (!text) return toast("\u6c92\u6709\u53ef\u8907\u88fd\u8cc7\u6599");
  copyText(text);
}

function toggleSelectAll(checked) {
  const rows = [];
  getScopeFriends().forEach((friend) => {
    getFilteredParcels(friend)
      .filter((parcel) => parcel.status !== "shipped_to_taiwan")
      .forEach((parcel) => rows.push(parcel));
  });
  rows.forEach((parcel) => {
    if (checked) state.selectedParcelIds.add(parcel.id);
    else state.selectedParcelIds.delete(parcel.id);
  });
  renderParcelRows();
}

async function init() {
  updatePersistenceBadge();
  updateFriendListCollapseUI();
  updateSidebarMenuUI();

  try {
    state.data = await loadFromBackend();
  } catch (error) {
    console.error(error);
    state.data = { ...EMPTY_DATA };
    toast("後端資料讀取失敗，請先確認 Railway API 設定");
  }

  state.selectedFriendId = state.data.friends[0]?.id || null;

  els.friendListToggleArea.addEventListener("click", () => {
    state.friendListCollapsed = !state.friendListCollapsed;
    updateFriendListCollapseUI();
  });

  if (els.friendMenuBtn) {
    els.friendMenuBtn.addEventListener("click", () => {
      if (!shouldUseSidebarDrawer()) return;
      state.sidebarMenuOpen = !state.sidebarMenuOpen;
      if (state.sidebarMenuOpen) {
        state.friendListCollapsed = false;
        updateFriendListCollapseUI();
      }
      updateSidebarMenuUI();
    });
  }

  if (els.sidebarBackdrop) {
    els.sidebarBackdrop.addEventListener("click", closeSidebarMenu);
  }

  window.addEventListener("resize", () => {
    if (!shouldUseSidebarDrawer()) state.sidebarMenuOpen = false;
    updateSidebarMenuUI();
  });

  els.addFriendBtn.addEventListener("click", addFriend);
  if (els.backHomeBtn) els.backHomeBtn.addEventListener("click", closeSidebarMenu);

  const toggleCardByBlankClick = (cardEl, stateKey) => {
    cardEl.addEventListener("click", (e) => {
      if (e.target.closest("input,textarea,select,button,a,label")) return;
      state[stateKey] = !state[stateKey];
      updateSectionCollapseUI();
    });
  };

  toggleCardByBlankClick(els.addParcelCard, "addParcelCollapsed");
  toggleCardByBlankClick(els.inboundCard, "inboundCollapsed");
  toggleCardByBlankClick(els.shipCard, "shipCollapsed");
  els.globalTrackingSearch.addEventListener("input", applyGlobalSearchFilter);

  els.bulkFriendSelect.addEventListener("change", (e) => {
    state.bulkTargetFriendId = e.target.value;
    updateBulkAddAvailability();
  });

  els.ownerFilter.addEventListener("change", (e) => {
    state.tableOwnerFilter = e.target.value || "all";
    state.selectedParcelIds.clear();
    renderFriendPanel();
  });

  els.bulkAddBtn.addEventListener("click", addBulkParcels);
  els.bulkInboundBtn.addEventListener("click", runBulkInbound);
  els.copyBulkInboundResultBtn.addEventListener("click", () => {
    if (!state.bulkInboundCopyText) return toast("目前沒有可複製的批量入庫結果");
    copyText(state.bulkInboundCopyText);
  });

  els.bulkShipBtn.addEventListener("click", runBulkShip);
  els.copyBulkShipResultBtn.addEventListener("click", () => {
    if (!state.bulkShipCopyText) return toast("目前沒有可複製的批量結果");
    copyText(state.bulkShipCopyText);
  });

  [els.searchInput, els.ownerFilter, els.statusFilter, els.priorityFilter].forEach((el) => {
    el.addEventListener("input", renderFriendPanel);
    el.addEventListener("change", renderFriendPanel);
  });

  els.selectAll.addEventListener("change", (e) => toggleSelectAll(e.target.checked));
  if (els.selectAllMobile) els.selectAllMobile.addEventListener("change", (e) => toggleSelectAll(e.target.checked));
  if (els.markArrivedBtn) els.markArrivedBtn.addEventListener("click", markSelectedArrived);
  els.markShippedBtn.addEventListener("click", markSelectedShipped);
  els.copyChinaBtn.addEventListener("click", copySelectedChina);
  if (els.copyChinaRemarkBtn) els.copyChinaRemarkBtn.addEventListener("click", copySelectedChinaWithRemark);
  els.copyTaiwanBtn.addEventListener("click", copySelectedTaiwan);
  if (els.shippedTaiwanSearch) {
    els.shippedTaiwanSearch.addEventListener("input", renderShippedSummary);
  }


  render();
}

init();
