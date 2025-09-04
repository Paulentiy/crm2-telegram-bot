// cardFlow.js — блок "Карты" для CRM2 бота

import { google } from "googleapis";
import nodeSchedule from "node-schedule";
import { Markup } from "telegraf";

/* ===== ENV ===== */
const SHEET_ID = process.env.CARDS_SPREADSHEET_ID || process.env.SPREADSHEET_ID; // ID таблицы Card_Flow_Manager
const SA_B64   = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
if (!SHEET_ID) throw new Error("cardFlow: missing CARDS_SPREADSHEET_ID / SPREADSHEET_ID");
if (!SA_B64)   throw new Error("cardFlow: missing GOOGLE_SERVICE_ACCOUNT_B64");

const SHEET_NAMES = JSON.parse(
  process.env.SHEET_NAMES_JSON ||
  '{"dashboard":"Дашборд","main":"Основные карты","buffer":"Буферные карты","ar":"Автореги","reissue":"Перевыпуски","settings":"Settings"}'
);

/* ===== Google Sheets client ===== */
const svc = JSON.parse(Buffer.from(SA_B64, "base64").toString("utf8"));
const auth = new google.auth.JWT(
  svc.client_email,
  null,
  svc.private_key,
  ["https://www.googleapis.com/auth/spreadsheets"]
);
const sheets = google.sheets({ version: "v4", auth });

/* ===== Tiny cache ===== */
const mem = new Map();
const setMem = (k, v, ms = 60_000) => mem.set(k, { v, exp: Date.now() + ms });
const getMem = (k) => {
  const it = mem.get(k);
  if (!it || Date.now() > it.exp) { mem.delete(k); return null; }
  return it.v;
};

/* ===== Settings / Admins / Subs ===== */
const SETTINGS_SHEET = SHEET_NAMES.settings || "Settings";

/** Settings: A chat_id, B username, E is_admin, F subscribed */
async function readSettings() {
  const c = getMem("settings");
  if (c) return c;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SETTINGS_SHEET}!A2:H`,
  });

  const list = (res.data.values || []).map((r) => ({
    chat_id: String(r[0] || "").trim(),            // A
    username: String(r[1] || "").trim(),           // B
    admin: /^true$/i.test(String(r[4] || "")),     // E
    subscribed: r[5] == null ? true : /^true$/i.test(String(r[5])), // F (если пусто — считаем true)
  }));

  setMem("settings", list, 60_000);
  return list;
}
async function isAdmin(chatId) {
  const me = String(chatId);
  const rows = await readSettings();
  return rows.some((r) => r.chat_id === me && r.admin);
}
async function listSubs() {
  const rows = await readSettings();
  return rows.filter((r) => r.subscribed && r.chat_id);
}
async function upsertSub(chatId, username = "") {
  const all = await readSettings();
  const me = String(chatId);
  const idx = all.findIndex((r) => r.chat_id === me);

  if (idx >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SETTINGS_SHEET}!F${idx + 2}`,
      valueInputOption: "RAW",
      requestBody: { values: [["TRUE"]] },
    });
    mem.delete("settings");
    return;
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SETTINGS_SHEET}!A:F`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[me, username || "", "", "", "", "TRUE"]] },
  });
  mem.delete("settings");
}
async function removeSub(chatId) {
  const all = await readSettings();
  const me = String(chatId);
  const idx = all.findIndex((r) => r.chat_id === me);
  if (idx < 0) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SETTINGS_SHEET}!F${idx + 2}`,
    valueInputOption: "RAW",
    requestBody: { values: [["FALSE"]] },
  });
  mem.delete("settings");
}

/* ===== Быстрые метрики / текст статуса ===== */
const MAIN_SHEET   = SHEET_NAMES.main   || "Основные карты";
const BUFFER_SHEET = SHEET_NAMES.buffer || "Буферные карты";

async function quickStats() {
  const c = getMem("quick");
  if (c) return c;

  // Основные: D "Слоты всего", E "Слоты занято", G "Холды $", I "Статус"
  const mainRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${MAIN_SHEET}!A2:K`,
  });
  const main = mainRes.data.values || [];

  let totalSlots = 0, usedSlots = 0, holds = 0, reissue = 0;
  for (const r of main) {
    const dTotal = Number(r[3] || 0);                         // D
    const dUsed  = Number(r[4] || 0);                         // E
    const h      = Number(String(r[6] || "0").replace(",", ".")); // G
    const status = String(r[8] || "").trim();                 // I

    if (!isNaN(dTotal)) totalSlots += dTotal;
    if (!isNaN(dUsed))  usedSlots  += dUsed;
    if (!isNaN(h))      holds      += h;
    if (/^к\s*перевыпуску$/i.test(status)) reissue += 1;
  }
  const freeSlots = Math.max(0, totalSlots - usedSlots);

  // Буферные: E "Статус" => "Свободна"
  const bufRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${BUFFER_SHEET}!A2:G`,
  });
  const buf = bufRes.data.values || [];
  let freeBuffer = 0;
  for (const r of buf) {
    const st = String(r[4] || "").trim(); // E
    if (/^свободна$/i.test(st)) freeBuffer += 1;
  }

  const out = { freeSlots, freeBuffer, holds, reissue };
  setMem("quick", out, 60_000);
  return out;
}

async function computeStatusText() {
  const { freeSlots, freeBuffer, holds, reissue } = await quickStats();

  const warn = [];
  if (freeSlots < 3)  warn.push(`Мало свободных слотов: ${freeSlots} (< 3)`);
  if (freeBuffer < 5) warn.push(`Мало свободных буферок: ${freeBuffer} (< 5)`);

  const warnLine = warn.length ? `\n⚠️ ${warn.join(" | ")}` : "";
  const tips = (freeSlots === 0 && freeBuffer === 0 && holds === 0)
    ? "\nℹ️ Таблица пустая — считаю нули. Можно начинать заполнять листы."
    : "";

  return [
    "📊 *Статус карт*",
    `Свободные слоты: *${freeSlots}*`,
    `Свободные буферки: *${freeBuffer}*`,
    `Зависшие холды: *$${holds.toFixed(2)}*`,
    `Карт к перевыпуску: *${reissue}*`,
    warnLine,
    tips
  ].join("\n");
}

/* ===== Клавиатуры ===== */
function buildMenu(isAdmin = false) {
  // Общие ряды
  const rows = [
    [Markup.button.callback("📊 Статус", "cards:status")],
    [Markup.button.callback("🔔 Подписаться", "cards:sub"), Markup.button.callback("🔕 Отписаться", "cards:unsub")],
  ];

  // Доп. строка только для админов — отдельным рядом
  if (isAdmin) {
    rows.push([Markup.button.callback("⚡ Проверить сейчас", "cards:checknow")]);
  }

  // Общие короткие метрики + закрыть
  rows.push(
    [Markup.button.callback("🧩 Слоты", "cards:slots"), Markup.button.callback("🧩 Буферки", "cards:buffers"), Markup.button.callback("🧩 Перевыпуск", "cards:reissue")],
    [Markup.button.callback("⬅️ Закрыть", "cards:close")],
  );

  return Markup.inlineKeyboard(rows);
}

/* ===== Регистрация обработчиков ===== */
export function registerCardFlow(bot) {
  // Кнопка «Карты»
  bot.hears("💳 Карты", async (ctx) => {
    const admin = await isAdmin(ctx.chat.id);
    await ctx.reply("Выбери действие по картам:", buildMenu(admin));
  });

  // Статус
  bot.action("cards:status", async (ctx) => {
    await ctx.answerCbQuery();
    const admin = await isAdmin(ctx.chat.id);
    const text = await computeStatusText();
    try {
      await ctx.editMessageText(text, { parse_mode: "Markdown", ...buildMenu(admin) });
    } catch {
      await ctx.reply(text, { parse_mode: "Markdown", ...buildMenu(admin) });
    }
  });

  // Подписка / Отписка
  bot.action("cards:sub", async (ctx) => {
    await ctx.answerCbQuery();
    await upsertSub(ctx.chat.id, ctx.from?.username || "");
    const admin = await isAdmin(ctx.chat.id);
    await ctx.reply("Подписал на автоуведомления ✅", buildMenu(admin));
  });

  bot.action("cards:unsub", async (ctx) => {
    await ctx.answerCbQuery();
    await removeSub(ctx.chat.id);
    const admin = await isAdmin(ctx.chat.id);
    await ctx.reply("Отписал от автоуведомлений ✅", buildMenu(admin));
  });

  // Ручная рассылка (строка только у админов — и тут проверяем)
  bot.action("cards:checknow", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await isAdmin(ctx.chat.id))) {
      return ctx.reply("Только для админов.", buildMenu(false));
    }
    const text = await computeStatusText();
    const subs = await listSubs();
    for (const s of subs) {
      try {
        await ctx.telegram.sendMessage(Number(s.chat_id), text, { parse_mode: "Markdown" });
      } catch (e) {
        console.error("send fail", s.chat_id, e?.message || e);
      }
    }
    await ctx.reply("Разослал ✅", buildMenu(true));
  });

  // Быстрые метрики
  bot.action("cards:slots", async (ctx) => {
    await ctx.answerCbQuery();
    const admin = await isAdmin(ctx.chat.id);
    const { freeSlots } = await quickStats();
    await ctx.reply(`Свободные слоты: *${freeSlots}*`, { parse_mode: "Markdown", ...buildMenu(admin) });
  });
  bot.action("cards:buffers", async (ctx) => {
    await ctx.answerCbQuery();
    const admin = await isAdmin(ctx.chat.id);
    const { freeBuffer } = await quickStats();
    await ctx.reply(`Свободные буферки: *${freeBuffer}*`, { parse_mode: "Markdown", ...buildMenu(admin) });
  });
  bot.action("cards:reissue", async (ctx) => {
    await ctx.answerCbQuery();
    const admin = await isAdmin(ctx.chat.id);
    const { reissue } = await quickStats();
    await ctx.reply(`Карт к перевыпуску: *${reissue}*`, { parse_mode: "Markdown", ...buildMenu(admin) });
  });

  bot.action("cards:close", async (ctx) => {
    await ctx.answerCbQuery();
    try { await ctx.editMessageText("Меню закрыто."); } catch {}
  });

  /* ===== Автоуведомления =====
     Киев 11:00, 15:00, 19:00, 23:00  => UTC 08:00, 12:00, 16:00, 20:00 */
  const CRON_RULE_UTC = "0 8,12,16,20 * * *";
  nodeSchedule.scheduleJob(CRON_RULE_UTC, async () => {
    try {
      const text = await computeStatusText();
      const subs = await listSubs();
      for (const s of subs) {
        try {
          await bot.telegram.sendMessage(Number(s.chat_id), text, { parse_mode: "Markdown" });
        } catch (e) {
          console.error("auto notify fail", s.chat_id, e?.message || e);
        }
      }
    } catch (e) {
      console.error("auto notify error", e?.message || e);
    }
  });
}
