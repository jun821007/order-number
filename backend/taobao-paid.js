"use strict";

const PAID_WINDOW_MS = 3 * 60 * 60 * 1000;
const RATE_MIN = 4.6;
const RATE_MAX = 5;

function parseTaipeiTime(ts) {
  const raw = String(ts || "").trim();
  if (!raw) return NaN;
  const value = Date.parse(`${raw.replace(" ", "T")}+08:00`);
  return Number.isFinite(value) ? value : NaN;
}

function compactPaidText(text) {
  return String(text || "").replace(/[\s\u3000\p{P}]+/gu, "");
}

function isPaidAck(text) {
  const compact = compactPaidText(text);
  return compact.length > 0 && compact.length <= 8 && compact.endsWith("付了");
}

function hasTaobaoPayLink(raw) {
  return raw.includes("支付寶_淘寶") || raw.includes("支付宝_淘宝");
}

function parseTwdAmount(raw) {
  const patterns = [
    /交易金[額额]\s*[:：]\s*(\d+(?:\.\d+)?)\s*元/,
    /(?:NT\s*\$|ＮＴ\s*＄|新台幣|新臺幣|金額)\s*[:：]?\s*\$?\s*(\d+(?:\.\d+)?)/,
    /(\d+(?:\.\d+)?)\s*元/
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    const twd = Number(match[1]);
    if (Number.isFinite(twd) && twd > 0) return twd;
  }
  return null;
}

function parseBankDebit(text) {
  const raw = String(text || "");
  const taobao = hasTaobaoPayLink(raw);
  const lineConvenience = raw.includes("中國信託") && raw.includes("方便付");
  const cardSpend = raw.includes("消費扣款") || raw.includes("消费扣款");
  // LINE 官方帳號要同時有「中國信託 方便付」和支付寶_淘寶連結。
  // 既有卡片通知仍要消費扣款＋支付寶_淘寶＋金額。
  if (lineConvenience) {
    if (!taobao) return null;
  } else if (!taobao || !cardSpend) {
    return null;
  }
  const twd = parseTwdAmount(raw);
  if (!Number.isFinite(twd)) return null;
  return { twd, source: lineConvenience ? "line-convenience" : "card" };
}

function rateOf(twd, cny) {
  const quote = Number(cny);
  if (!Number.isFinite(twd) || !Number.isFinite(quote) || quote <= 0) return null;
  return twd / quote;
}

function rateOk(twd, cny) {
  const rate = rateOf(twd, cny);
  return rate !== null && rate >= RATE_MIN && rate <= RATE_MAX;
}

function quoteTime(pending) {
  return parseTaipeiTime(pending && pending.message_ts);
}

function nearestUnpaidQuote(pending, atMs) {
  if (!Number.isFinite(atMs)) return null;
  const candidates = (Array.isArray(pending) ? pending : []).filter((item) => {
    if (!item || !Array.isArray(item.items) || !item.items.length) return false;
    if (!Number.isFinite(Number(item.cny)) || Number(item.cny) <= 0) return false;
    if (Number.isFinite(Number(item.paid_twd))) return false;
    const at = quoteTime(item);
    return Number.isFinite(at) && at <= atMs;
  });
  candidates.sort((a, b) => quoteTime(b) - quoteTime(a));
  return candidates[0] || null;
}

function pushLog(inbox, nowIso, messageTs, text) {
  inbox.log.push({ at: nowIso, message_ts: messageTs || "", type: "paid", text });
}

function moneyTime(debit) {
  return `${debit.twd} 元，時間 ${debit.at || "未知"}`;
}

function reconcilePaidQuotes(inbox, nowIso) {
  if (!inbox.paid_acks) inbox.paid_acks = [];
  if (!inbox.bank_debits) inbox.bank_debits = [];
  const acks = inbox.paid_acks
    .filter((ack) => ack && ack.state === "open" && ack.quote_id)
    .sort((a, b) => parseTaipeiTime(a.at) - parseTaipeiTime(b.at));

  acks.forEach((ack) => {
    const quote = (inbox.pending || []).find((item) => item.id === ack.quote_id);
    if (!quote || Number.isFinite(Number(quote.paid_twd))) {
      ack.state = "closed";
      return;
    }
    const at = parseTaipeiTime(ack.at);
    if (!Number.isFinite(at)) {
      ack.state = "closed";
      return;
    }
    const openDebits = inbox.bank_debits.filter((debit) => {
      if (!debit || debit.state !== "open") return false;
      const debitAt = parseTaipeiTime(debit.at);
      return Number.isFinite(debitAt) && Math.abs(debitAt - at) <= PAID_WINDOW_MS;
    });
    const fitting = openDebits
      .filter((debit) => rateOk(debit.twd, quote.cny))
      .sort((a, b) => Math.abs(parseTaipeiTime(a.at) - at) - Math.abs(parseTaipeiTime(b.at) - at));
    if (fitting.length >= 2) {
      const nearestGap = Math.abs(parseTaipeiTime(fitting[0].at) - at);
      const tied = fitting.filter((debit) => Math.abs(parseTaipeiTime(debit.at) - at) === nearestGap);
      if (tied.length >= 2) {
        ack.state = "blocked";
        pushLog(
          inbox,
          nowIso,
          ack.at,
          `淘寶/3 小時內兩筆扣款同樣最近且都落在 4.6～5（${tied.map(moneyTime).join("、")}），沒有掛上台幣`
        );
        return;
      }
    }
    if (fitting.length >= 1) {
      const debit = fitting[0];
      const rivals = acks.filter((other) => {
        if (other === ack || other.state !== "open") return false;
        const otherQuote = (inbox.pending || []).find((item) => item.id === other.quote_id);
        if (!otherQuote || Number.isFinite(Number(otherQuote.paid_twd))) return false;
        const otherAt = parseTaipeiTime(other.at);
        const debitAt = parseTaipeiTime(debit.at);
        if (!Number.isFinite(otherAt) || !Number.isFinite(debitAt)) return false;
        if (Math.abs(debitAt - otherAt) > PAID_WINDOW_MS) return false;
        return rateOk(debit.twd, otherQuote.cny);
      });
      const closest = rivals.reduce((best, other) => {
        const bestGap = Math.abs(parseTaipeiTime(best.at) - parseTaipeiTime(debit.at));
        const otherGap = Math.abs(parseTaipeiTime(other.at) - parseTaipeiTime(debit.at));
        return otherGap < bestGap ? other : best;
      }, ack);
      if (closest !== ack) return;
      const cny = Number(quote.cny);
      quote.paid_twd = Number(debit.twd.toFixed(2));
      quote.paid_rate = Number((debit.twd / cny).toFixed(2));
      debit.state = "used";
      ack.state = "attached";
      pushLog(
        inbox,
        nowIso,
        ack.at,
        `淘寶/付了已掛台幣 ${quote.paid_twd}，匯率 ${quote.paid_rate}，拍 ${cny}，整筆不拆`
      );
      return;
    }
    openDebits.forEach((debit) => {
      if (debit.out_of_range_logged) return;
      debit.out_of_range_logged = true;
      pushLog(
        inbox,
        nowIso,
        ack.at,
        `淘寶/最近一則拍 ${quote.cny} 對扣款 ${moneyTime(debit)} 匯率超出 4.6～5，沒有改掛更早的拍`
      );
    });
  });
}

module.exports = {
  PAID_WINDOW_MS,
  RATE_MIN,
  RATE_MAX,
  parseTaipeiTime,
  isPaidAck,
  parseBankDebit,
  rateOk,
  nearestUnpaidQuote,
  reconcilePaidQuotes
};
