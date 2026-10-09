// ==UserScript==
// @name         單號分類工具：淘寶訊息同步
// @namespace    order-number-tool
// @version      1.2.0
// @description  讀取淘寶網頁版聊天裡的訊息，送到單號分類工具自動入庫、建立待確認出貨
// @match        https://market.m.taobao.com/*
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @connect      order-number-production.up.railway.app
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  if (!location.pathname.includes("/app/im/")) return;
  console.log("[單號工具同步] 已啟動");

  const BACKEND_URL = "https://order-number-production.up.railway.app";
  const DEBOUNCE_MS = 2000;
  const FALLBACK_POLL_MS = 60000;
  const MAX_REMEMBERED_IDS = 3000;
  const TS_RE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;
  const TS_RE_GLOBAL = new RegExp(TS_RE.source, "g");
  const NOISE_LINES = new Set(["已读", "未读", "已讀", "未讀"]);

  let container = null;
  let sending = false;
  let sentIds = new Set(GM_getValue("sentIds", []));

  const panel = document.createElement("div");
  panel.style.cssText = [
    "position:fixed", "left:12px", "bottom:12px", "z-index:2147483647",
    "background:#111827", "color:#fff", "font:12px/1.5 sans-serif",
    "padding:8px 10px", "border-radius:10px", "box-shadow:0 4px 14px rgba(0,0,0,.3)", "max-width:260px"
  ].join(";");
  panel.innerHTML = `
    <div style="font-weight:700;margin-bottom:4px">單號工具同步</div>
    <div data-role="status">啟動中…</div>
    <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
      <button data-role="sync" style="cursor:pointer">立即同步</button>
      <button data-role="diag" style="cursor:pointer">診斷</button>
      <button data-role="secret" style="cursor:pointer">重設密鑰</button>
    </div>`;
  const statusEl = panel.querySelector('[data-role="status"]');

  function ensurePanel() {
    if (!panel.isConnected) (document.body || document.documentElement).appendChild(panel);
  }
  ensurePanel();

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.style.color = isError ? "#fca5a5" : "#d1fae5";
  }

  function getSecret(forcePrompt) {
    let secret = forcePrompt ? "" : GM_getValue("inboxSecret", "");
    if (!secret) {
      secret = (prompt("請貼上單號分類工具的 INBOX_SECRET：") || "").trim();
      if (secret) GM_setValue("inboxSecret", secret);
    }
    return secret;
  }

  function countTimestamps(text) {
    return (text.match(TS_RE_GLOBAL) || []).length;
  }

  // Chat UI may live inside open shadow roots or same-origin iframes, so search all of them.
  function collectRoots() {
    const roots = [];
    const visit = (root) => {
      roots.push(root);
      root.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) visit(el.shadowRoot);
        if (el.tagName === "IFRAME") {
          try {
            if (el.contentDocument && el.contentDocument.body) visit(el.contentDocument);
          } catch {
            // cross-origin iframe
          }
        }
      });
    };
    visit(document);
    return roots;
  }

  // The message list is the smallest element holding the most "yyyy-mm-dd hh:mm:ss" headers.
  function findMessageContainer() {
    if (container && container.isConnected && countTimestamps(container.innerText || "")) return container;
    let best = null;
    let bestCount = 0;
    let bestLength = Infinity;
    const candidates = collectRoots().flatMap((root) => [...root.querySelectorAll("div, ul, section")]);
    candidates.forEach((el) => {
      if (panel.contains(el)) return;
      const text = el.innerText || "";
      const count = countTimestamps(text);
      if (!count) return;
      if (count > bestCount || (count === bestCount && text.length < bestLength)) {
        best = el;
        bestCount = count;
        bestLength = text.length;
      }
    });
    container = best;
    return best;
  }

  function parseMessages(text) {
    const lines = text.split("\n").map((line) => line.trim()).filter((line) => line && !NOISE_LINES.has(line));
    const messages = [];
    let current = null;

    const flush = () => {
      if (current && current.lines.length) {
        const body = current.lines.join("\n");
        messages.push({ id: `${current.ts}|${body}`, ts: current.ts, sender: current.sender, text: body });
      }
    };

    lines.forEach((line) => {
      const match = line.match(TS_RE);
      if (match) {
        flush();
        const rest = line.replace(match[0], "").trim();
        current = { ts: match[0], sender: rest, lines: [], expectSender: !rest };
        return;
      }
      if (!current) return;
      if (current.expectSender && !current.lines.length && /^[\w.\-]{2,32}$/.test(line)) {
        current.sender = line;
        current.expectSender = false;
        return;
      }
      current.lines.push(line);
    });
    flush();
    return messages;
  }

  function rememberSent(ids) {
    ids.forEach((id) => sentIds.add(id));
    const list = [...sentIds].slice(-MAX_REMEMBERED_IDS);
    sentIds = new Set(list);
    GM_setValue("sentIds", list);
  }

  function postMessages(messages, secret) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: `${BACKEND_URL}/api/inbox/messages`,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        data: JSON.stringify({ messages }),
        timeout: 20000,
        onload: (res) => {
          let json = null;
          try { json = JSON.parse(res.responseText); } catch { json = null; }
          if (res.status >= 200 && res.status < 300) resolve(json || {});
          else reject(Object.assign(new Error(`HTTP ${res.status}`), { status: res.status }));
        },
        onerror: () => reject(new Error("網路錯誤")),
        ontimeout: () => reject(new Error("連線逾時"))
      });
    });
  }

  async function syncOnce(force) {
    if (sending) return;
    const target = findMessageContainer();
    if (!target) {
      setStatus("找不到聊天訊息區，請打開集運站對話", true);
      return;
    }
    const messages = parseMessages(target.innerText || "");
    const unsent = force ? messages : messages.filter((m) => !sentIds.has(m.id));
    if (!unsent.length) {
      setStatus(`運作中｜畫面 ${messages.length} 則，沒有新訊息`);
      return;
    }

    const secret = getSecret(false);
    if (!secret) {
      setStatus("尚未設定密鑰", true);
      return;
    }

    sending = true;
    try {
      const result = await postMessages(unsent, secret);
      rememberSent(unsent.map((m) => m.id));
      const time = new Date().toLocaleTimeString("zh-TW", { hour12: false });
      setStatus(`${time} 送出 ${unsent.length} 則｜入庫 ${result.inbound || 0}、待出貨 ${result.quotes || 0}`);
    } catch (error) {
      if (error.status === 401) setStatus("密鑰錯誤，請按「重設密鑰」", true);
      else setStatus(`送出失敗：${error.message}`, true);
    } finally {
      sending = false;
    }
  }

  panel.querySelector('[data-role="sync"]').addEventListener("click", () => syncOnce(true));
  panel.querySelector('[data-role="secret"]').addEventListener("click", () => {
    if (getSecret(true)) setStatus("密鑰已更新");
  });
  panel.querySelector('[data-role="diag"]').addEventListener("click", () => {
    container = null;
    const target = findMessageContainer();
    const text = target ? target.innerText || "" : "";
    const roots = collectRoots();
    const bodyText = document.body ? document.body.innerText || "" : "";
    const report = {
      url: location.href,
      containerFound: Boolean(target),
      containerTag: target ? `${target.tagName}.${target.className}` : null,
      parsed: parseMessages(text).slice(-5),
      rawTail: text.slice(-1500),
      iframes: [...document.querySelectorAll("iframe")].map((f) => f.src || "(no src)"),
      shadowRoots: roots.filter((r) => r instanceof ShadowRoot).length,
      sameOriginFrames: roots.filter((r) => r instanceof Document && r !== document).length,
      timeLikeSamples: (bodyText.match(/\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\s+\d{1,2}:\d{2}(?::\d{2})?|\b\d{1,2}:\d{2}(?::\d{2})?\b/g) || []).slice(-10),
      bodyTextLength: bodyText.length,
      bodyTail: bodyText.slice(-1500)
    };
    GM_setClipboard(JSON.stringify(report, null, 2));
    alert("診斷資料已複製，貼給工程師即可。");
  });

  // Only react when the page actually changes (new message rendered); the slow poll is a safety net.
  let debounceTimer = null;
  const observer = new MutationObserver((mutations) => {
    if (debounceTimer || mutations.every((m) => panel.contains(m.target))) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      syncOnce(false);
    }, DEBOUNCE_MS);
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });

  setInterval(() => {
    ensurePanel();
    syncOnce(false);
  }, FALLBACK_POLL_MS);
  setTimeout(() => syncOnce(false), 1500);
})();
