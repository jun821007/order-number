"use strict";

const {
  isPaidAck,
  parseBankDebit,
  rateOk,
  nearestUnpaidQuote,
  reconcilePaidQuotes,
  parseTaipeiTime
} = require("./taobao-paid");

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

assert(isPaidAck("付了"), "exact");
assert(isPaidAck("  付了。 "), "punctuation");
assert(isPaidAck("已付了"), "short ending");
assert(!isPaidAck("我已經把這筆貨款付了謝謝你"), "long text");
assert(!isPaidAck("付了之後再出貨"), "does not end with it");

const bank = "中國信託 支付寶_淘寶 消費扣款 交易金額：204元";
assert(parseBankDebit(bank).twd === 204, "bank amount");
assert(parseBankDebit("支付寶_淘寶 消費扣款") === null, "bank needs amount");
assert(parseBankDebit("交易金額：204元") === null, "bank needs taobao spend");
assert(parseBankDebit("支付宝_淘宝 消费扣款 交易金额：88.5元").twd === 88.5, "simplified");
assert(parseBankDebit("中國信託 方便付 支付寶_淘寶 NT$204").twd === 204, "line convenience");
assert(parseBankDebit("中國信託 方便付 商店連結 NT$204") === null, "line needs taobao link");
assert(parseBankDebit("中國信託 方便付 支付寶_淘寶") === null, "line needs amount");
assert(rateOk(460, 100) && rateOk(500, 100), "rate inclusive edges");
assert(!rateOk(459, 100) && !rateOk(501, 100), "rate outside stays out");

function quote(id, ts, cny) {
  return {
    id,
    message_ts: ts,
    cny,
    items: [{ tracking: "YT1", weight: 1 }, { tracking: "YT2", weight: 1 }]
  };
}

const inbox = {
  pending: [quote("a", "2026-10-19 10:00:00", 10), quote("b", "2026-10-19 12:00:00", 41)],
  paid_acks: [],
  bank_debits: [],
  log: []
};

const ackAt = "2026-10-19 12:10:00";
const nearest = nearestUnpaidQuote(inbox.pending, parseTaipeiTime(ackAt));
assert(nearest.id === "b", "nearest quote is the later one");
inbox.paid_acks.push({ id: "ack1", at: ackAt, quote_id: nearest.id, state: "open" });
inbox.bank_debits.push({ id: "d1", at: "2026-10-19 12:20:00", twd: 49, state: "open" });
reconcilePaidQuotes(inbox, "2026-10-19T04:30:00.000Z");
assert(!Number.isFinite(Number(inbox.pending[0].paid_twd)), "older quote stays unpaid");
assert(!Number.isFinite(Number(inbox.pending[1].paid_twd)), "out of range does not attach");
assert(inbox.log.some((entry) => entry.text.includes("沒有改掛更早的拍")), "out of range is logged");

inbox.bank_debits.push({ id: "d2", at: "2026-10-19 12:30:00", twd: 204, state: "open" });
inbox.bank_debits.push({ id: "d3", at: "2026-10-19 12:40:00", twd: 205, state: "open" });
reconcilePaidQuotes(inbox, "2026-10-19T04:40:00.000Z");
assert(inbox.pending[1].paid_twd === 204, "nearest in-range debit attaches");
assert(inbox.bank_debits.find((debit) => debit.id === "d3").state === "open", "farther debit stays unused");

const tied = {
  pending: [quote("t", "2026-10-19 13:00:00", 41)],
  paid_acks: [{ id: "ackt", at: "2026-10-19 13:00:00", quote_id: "t", state: "open" }],
  bank_debits: [
    { id: "t1", at: "2026-10-19 13:10:00", twd: 204, state: "open" },
    { id: "t2", at: "2026-10-19 12:50:00", twd: 205, state: "open" }
  ],
  log: []
};
reconcilePaidQuotes(tied, "2026-10-19T05:20:00.000Z");
assert(!Number.isFinite(Number(tied.pending[0].paid_twd)), "exact time tie does not attach");
assert(tied.log.some((entry) => entry.text.includes("同樣最近")), "tie is logged");

const later = {
  pending: [quote("c", "2026-10-19 15:00:00", 41)],
  paid_acks: [{ id: "ack2", at: "2026-10-19 15:05:00", quote_id: "c", state: "open" }],
  bank_debits: [],
  log: []
};
reconcilePaidQuotes(later, "2026-10-19T07:06:00.000Z");
assert(!Number.isFinite(Number(later.pending[0].paid_twd)), "waits for the bank");
later.bank_debits.push({ id: "d4", at: "2026-10-19 16:00:00", twd: 204, state: "open" });
reconcilePaidQuotes(later, "2026-10-19T08:01:00.000Z");
assert(later.pending[0].paid_twd === 204, "later debit attaches");
assert(later.pending[0].paid_rate === 4.98, "rate");
assert(later.pending[0].items.length === 2, "not split");
assert(later.pending[0].settlement_total_twd === undefined, "not settlement");
assert(later.bank_debits[0].state === "used", "debit used");

console.log("taobao-paid tests ok");
