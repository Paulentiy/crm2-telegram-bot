// cardFlow.js — блок "Карты" для CRM2 бота

import { google } from "googleapis";
import nodeSchedule from "node-schedule";
import { Markup } from "telegraf";

/* ===== ENV ===== */
// Таблица с данными по картам (Дашборд, Основные/Буферные и т.п.)
const CARDS_SHEET_ID =
  process.env.CARDS_SPREADSHEET_ID || process.env.SPREADSHEET_ID;
// Таблица, где находится лист Settings (админы/подписки) — это твоя основная
const SETTINGS_SHEET_ID = process.env.SPREADSHEET_ID;

const SA_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;

if (!CARDS_SHEET_ID) throw new Error("cardFlow: missing CARDS_SPREADSHEET_ID / SPREADSHEET_ID");
if (!SETTINGS_SHEET_ID) throw new Error("cardFlow: missing SPREADSHEET_ID for Settings");
if (!SA_B64) throw new Error("cardFlow: missing GOOGLE_SERVICE_ACCOUNT_B64");

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

/* ===== Mini cache ===== */
const mem = new Map();
const setMem = (k, v, ms = 60_000) => mem.set(k, { v, exp: Date.now() + ms });
const getMem = (k) => {
  const it = mem.get(k);
  if (!it || Date.now() > it.exp) {
    mem.delete(k);
    return null;
  }
  return it.v;
};

/* ===== Settings / Admins / Subs ===== */
const SETTINGS_SHEET = SHEET_NAMES.settings || "Settings";

/** Читаем все строки Settings основной таблицы
 * A chat_id | B username | C threshold_slots | D threshold_buffer_free | E is_admin | F subscribed?
 */
async function readSettings() {
  const cached = getMem("settings");
  if (cached) return cached;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SETTINGS_SHEET_ID,
    range: `${SETTINGS_SHEET}!A2:H`,
  });

  const list = (res.data.values || []).map((r) => ({
    chat_id: String(r[0] || "").trim(),
    username: String(r[1] || "").trim(),
    admin: /^true$/i.test(String(r[4] || "")), // E
    subscribed: r[5] == null ? true : /^true$/i.test(String(r[5])), // F, по умолчанию TRUE
  }));

  setMem("settings", list, 60_000);
  return list;
}

async function isAdmin(chatId) {
  const me = String(chatId);
  const rows = await readSettings();
  return rows.some((r) => r.chat_id === me && r.admin);
}

/** Список подписчиков (учитываем F=subscribed если есть) */
async function listSubs() {
  const rows = await readSettings();
  return rows.filter((r) => r.subscribed && r.chat_id);
}

/** Подписаться: если есть строка — ставим F=TRUE, иначе добавляем новую */
async function upsertSub(chatId, username = "") {
  const all = await readSettings();
  const me = String(chatId);
  const idx = all.findIndex((r) => r.chat_id === me);

  if (idx >= 0) {
    // включим подписку в колонке F, не трогая is_admin (E)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SETTINGS_SHEET_ID,
      range: `${SETTINGS_SHEET}!F${idx + 2}`,
      valueInputOption: "RAW",
      requestBody: { values: [["TRUE"]] },
    });
    mem.delete("settings");
    return;
  }

  // добавим новую строку в основной Settings: chat_id, username, -, -, -, subscribed=TRUE
  await sheets.spreadsheets.values.append({
    spreadsheetId: SETTINGS_SHEET_ID,
    range: `${SETTINGS_SHEET}!A:F`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[me, username || "", "", "", "", "TRUE"]] },
  });
  mem.delete("settings");
}

/** Отписаться: ставим F=FALSE */
async function removeSub(chatId) {
  const all = await readSettings();
  const me = String(chatId);
  const idx = all.findIndex((r) => r.chat_id === me);
  if (idx < 0) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SETTINGS_SHEET_ID,
    range: `${SETTINGS_SHEET}!F${idx + 2}`,
    valueInputOption: "RAW",
    requestBody: { values: [["FALSE"]] },
  });
  mem.delete("settings");
}

/* ===== Быстрые метрики / текст статуса (из карточной таблицы) ===== */
const MAIN_SHEET   = SHEET_NAMES.main   || "Основные карты";
const BUFFER_SHEET = SHEET_NAMES.buffer || "Буферные карты";

async function quickStats() {
  const cacheKey = "quick";
  const c = getMem(cacheKey);
  if (c) return c;

  // Основные: D "Слоты всего", E "Слоты занято", G "Холды $", I "Статус"
  const mainRes = await sheets.spreadsheets.values.get({
    spreadsheetId: CARDS_SHEET_ID,
    range: `${MAIN_SHEET}!A2:K`,
  });
  const main = mainRes.data.values || [];

  let totalSlots = 0;
  let usedSlots = 0;
  let holds = 0;
  let reissue = 0;

  for (const r of main) {
    const dTotal = Number(r[3] || 0); // D
    const dUsed  = Number(r[4] || 0); // E
    const h      = Number(String(r[6] || "0").replace(",", ".")); // G
    const status = String(r[8] || "").trim(); // I

    if (!isNaN(dTotal)) totalSlots += dTotal;
    if (!isNaN(dUsed))  usedSlots  += dUsed;
    if (!isNaN(h))      holds      += h;
    if (/^к\s*перевыпуску$/i.test(status)) reissue += 1;
  }
  const freeSlots = Math.max(0, totalSlots - usedSlots);

  // Буферные: E "Статус" => Свободна
  const bufRes = await sheets.spreadsheets.values.get({
    spreadsheetId: CARDS_SHEET_ID,
    range: `${BUFFER_SHEET}!A2:G`,
  });
  const buf = bufRes.data.values || [];
  let freeBuffer = 0;
  for (const r of buf) {
    const st = String(r[4] || "").trim(); // E
    if (/^свободна$/i.test(st)) freeBuffer += 1;
  }

  const out = { freeSlots, freeBuffer, holds, reissue };
  setMem(cacheKey, out, 60_000);
  return out;
}

async function computeStatusText() {
  const { freeSlots, freeBuffer, holds, reissue } = await quickStats();

  const warnParts = [];
  if (freeSlots < 3)  warnParts.push(`Мало свободных слотов: ${freeSlots} (< 3)`);
  if (freeBuffer < 5) warnParts.push(`Мало свободных буферок: ${freeBuffer} (< 5)`);

  const warnLine = warnParts.length ? `\n⚠️ ${warnParts.join(" | ")}` : "";

  const tips =
    freeSlots === 0 && freeBuffer === 0 && holds === 0
      ? "\nℹ️ Таблица пустая — считаю нули. Можно начинать заполнять листы."
      : "";

  return [
    "📊 *Статус карт*",
    `Свободные слоты: *${freeSlots}*`,
    `Свободные буферки: *${freeBuffer}*`,
    `Зависшие холды: *$${holds.toFixed(2)}*`,
    `Карт к перевыпуску: *${reissue}*`,
    warnLine,
    tips,
  ].join("\n");
}

/* ===== Меню и обработчики ===== */

// «Заглушка»-кнопка для разделителя
const dividerBtn = Markup.button.callback("🔒 Только для админов", "cards:noop");

async function buildMenuFor(ctx) {
  const commonRows = [
    [Markup.button.callback("📊 Статус", "cards:status")],
    [
      Markup.button.callback("🔔 Подписаться", "cards:sub"),
      Markup.button.callback("🔕 Отписаться", "cards:unsub"),
    ],
    [
      Markup.button.callback("🧩 Слоты", "cards:slots"),
      Markup.button.callback("🧩 Буферки", "cards:buffers"),
      Markup.button.callback("🧩 Перевыпуск", "cards:reissue"),
    ],
    [Markup.button.callback("⬅️ Закрыть", "cards:close")],
  ];

  if (await isAdmin(ctx.chat.id)) {
    // отдельная строка для админов + их кнопки
    commonRows.splice(3, 0, [dividerBtn]);
    commonRows.splice(4, 0, [Markup.button.callback("⚡ Проверить сейчас", "cards:checknow")]);
  }

  return Markup.inlineKeyboard(commonRows);
}

export function registerCardFlow(bot) {
  // Главная кнопка «Карты»
  bot.hears("💳 Карты", async (ctx) => {
    const kb = await buildMenuFor(ctx);
    await ctx.reply("Выбери действие по картам:", kb);
  });

  // Статус
  bot.action("cards:status", async (ctx) => {
    await ctx.answerCbQuery();
    const text = await computeStatusText();
    try {
      const kb = await buildMenuFor(ctx);
      await ctx.editMessageText(text, { parse_mode: "Markdown", ...kb });
    } catch {
      const kb = await buildMenuFor(ctx);
      await ctx.reply(text, { parse_mode: "Markdown", ...kb });
    }
  });

  // Подписка / Отписка
  bot.action("cards:sub", async (ctx) => {
    await ctx.answerCbQuery();
    await upsertSub(ctx.chat.id, ctx.from?.username || "");
    const kb = await buildMenuFor(ctx);
    await ctx.reply("Подписал на автоуведомления ✅", kb);
  });

  bot.action("cards:unsub", async (ctx) => {
    await ctx.answerCbQuery();
    await removeSub(ctx.chat.id);
    const kb = await buildMenuFor(ctx);
    await ctx.reply("Отписал от автоуведомлений ✅", kb);
  });

  // Ручная рассылка — только админам
  bot.action("cards:checknow", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await isAdmin(ctx.chat.id))) {
      const kb = await buildMenuFor(ctx);
      return ctx.reply("Только для админов.", kb);
    }
    const text = await computeStatusText();
    const subs = await listSubs();
    for (const s of subs) {
      try {
        await ctx.telegram.sendMessage(Number(s.chat_id), text, { parse_mode: "Markdown" });
      } catch (e) {
        console.error("auto send fail", s.chat_id, e?.message || e);
      }
    }
    const kb = await buildMenuFor(ctx);
    await ctx.reply("Разослал ✅", kb);
  });

  // Быстрые метрики
  bot.action("cards:slots", async (ctx) => {
    await ctx.answerCbQuery();
    const { freeSlots } = await quickStats();
    await ctx.reply(`Свободные слоты: *${freeSlots}*`, { parse_mode: "Markdown" });
  });
  bot.action("cards:buffers", async (ctx) => {
    await ctx.answerCbQuery();
    const { freeBuffer } = await quickStats();
    await ctx.reply(`Свободные буферки: *${freeBuffer}*`, { parse_mode: "Markdown" });
  });
  bot.action("cards:reissue", async (ctx) => {
    await ctx.answerCbQuery();
    const { reissue } = await quickStats();
    await ctx.reply(`Карт к перевыпуску: *${reissue}*`, { parse_mode: "Markdown" });
  });

  // Разделитель
  bot.action("cards:noop", async (ctx) => ctx.answerCbQuery("Для админов"));

  bot.action("cards:close", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await ctx.editMessageText("Меню закрыто.");
    } catch {}
  });

  /* ===== Автоуведомления по расписанию =====
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
