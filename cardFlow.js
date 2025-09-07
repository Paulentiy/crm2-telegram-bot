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

/** Читаем все строки Settings: A chat_id, B username, E is_admin, (опц.) F subscribed */
async function readSettings() {
  const cached = getMem("settings");
  if (cached) return cached;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SETTINGS_SHEET}!A2:H`,
  });

  const list = (res.data.values || []).map((r) => ({
    chat_id: String(r[0] || "").trim(),
    username: String(r[1] || "").trim(),
    admin: /^true$/i.test(String(r[4] || "")),               // E
    subscribed: r[5] == null ? true : /^true$/i.test(String(r[5])), // F (если нет — считаем подписан)
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

/** Подписаться: если есть строка — просто включаем F=TRUE, иначе добавляем новую */
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

  // chat_id | username | - | - | - | subscribed=TRUE
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SETTINGS_SHEET}!A:F`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[me, username || "", "", "", "", "TRUE"]] },
  });
  mem.delete("settings");
}

/** Отписаться: ставим F=FALSE (если нет колонки — просто игнор) */
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

/**
 * Быстрая сводка. При force=true читаем таблицу напрямую (без кеша).
 */
async function quickStats(force = false) {
  const cacheKey = "quick";
  if (!force) {
    const c = getMem(cacheKey);
    if (c) return c;
  }

  // Основные: D "Слоты всего", E "Слоты занято", G "Холды $", I "Статус"
  const mainRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${MAIN_SHEET}!A2:K`,
  });
  const main = mainRes.data.values || [];

  let totalSlots = 0;
  let usedSlots  = 0;
  let holds      = 0;
  let reissue    = 0;

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
  if (!force) setMem(cacheKey, out, 60_000);
  return out;
}

async function computeStatusText(force = false) {
  const { freeSlots, freeBuffer, holds, reissue } = await quickStats(force);

  const warnParts = [];
  if (freeSlots < 3)  warnParts.push(`Мало свободных слотов: ${freeSlots} (< 3)`);
  if (freeBuffer < 5) warnParts.push(`Мало свободных буферок: ${freeBuffer} (< 5)`);

  const warnLine = warnParts.length ? `\n⚠️ ${warnParts.join(" | ")}` : "";
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

/* ===== Меню и обработчики ===== */
export function registerCardFlow(bot) {
  const baseMenu = () =>
    Markup.inlineKeyboard([
      [Markup.button.callback("📊 Статус", "cards:status")],
      [Markup.button.callback("🔔 Подписаться", "cards:sub"), Markup.button.callback("🔕 Отписаться", "cards:unsub")],
      [Markup.button.callback("🧩 Слоты", "cards:slots"), Markup.button.callback("🧩 Буферки", "cards:buffers"), Markup.button.callback("🧩 Перевыпуск", "cards:reissue")],
      [Markup.button.callback("🛠 Только для админов", "cards:admin")],
      [Markup.button.callback("⬅️ Закрыть", "cards:close")],
    ]);

  const adminMenu = () =>
    Markup.inlineKeyboard([
      [Markup.button.callback("📊 Статус", "cards:status")],
      [Markup.button.callback("⚡ Проверить сейчас", "cards:checknow")],
      [Markup.button.callback("🧩 Слоты", "cards:slots"), Markup.button.callback("🧩 Буферки", "cards:buffers"), Markup.button.callback("🧩 Перевыпуск", "cards:reissue")],
      [Markup.button.callback("⬅️ Закрыть", "cards:close")],
    ]);

  // Главная кнопка «Карты»
  bot.hears("💳 Карты", async (ctx) => {
    await ctx.reply("Выбери действие по картам:", baseMenu());
  });

  // Разворачиваем «только для админов» в отдельную строку
  bot.action("cards:admin", async (ctx) => {
    await ctx.answerCbQuery();
    if (await isAdmin(ctx.chat.id)) {
      await ctx.reply("Только для админов.", adminMenu());
    } else {
      await ctx.reply("Недоступно: вы не админ.");
    }
  });

  // Статус — всегда свежие данные
  bot.action("cards:status", async (ctx) => {
    await ctx.answerCbQuery();
    const text = await computeStatusText(true); // force
    try {
      await ctx.editMessageText(text, { parse_mode: "Markdown", ...baseMenu() });
    } catch {
      await ctx.reply(text, { parse_mode: "Markdown", ...baseMenu() });
    }
  });

  // Подписка / Отписка
  bot.action("cards:sub", async (ctx) => {
    await ctx.answerCbQuery();
    await upsertSub(ctx.chat.id, ctx.from?.username || "");
    await ctx.reply("Подписал на автоуведомления ✅", baseMenu());
  });

  bot.action("cards:unsub", async (ctx) => {
    await ctx.answerCbQuery();
    await removeSub(ctx.chat.id);
    await ctx.reply("Отписал от автоуведомлений ✅", baseMenu());
  });

  // Ручная рассылка — только админам, и только свежие цифры
  bot.action("cards:checknow", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await isAdmin(ctx.chat.id))) {
      return ctx.reply("Только для админов.", baseMenu());
    }
    const text = await computeStatusText(true); // force
    const subs = await listSubs();
    for (const s of subs) {
      try {
        await ctx.telegram.sendMessage(Number(s.chat_id), text, { parse_mode: "Markdown" });
      } catch (e) {
        console.error("auto send fail", s.chat_id, e?.message || e);
      }
    }
    await ctx.reply("Разослал ✅", baseMenu());
  });

  // Быстрые метрики (тоже актуальные)
  bot.action("cards:slots", async (ctx) => {
    await ctx.answerCbQuery();
    const { freeSlots } = await quickStats(true);
    await ctx.reply(`Свободные слоты: *${freeSlots}*`, { parse_mode: "Markdown" });
  });
  bot.action("cards:buffers", async (ctx) => {
    await ctx.answerCbQuery();
    const { freeBuffer } = await quickStats(true);
    await ctx.reply(`Свободные буферки: *${freeBuffer}*`, { parse_mode: "Markdown" });
  });
  bot.action("cards:reissue", async (ctx) => {
    await ctx.answerCbQuery();
    const { reissue } = await quickStats(true);
    await ctx.reply(`Карт к перевыпуску: *${reissue}*`, { parse_mode: "Markdown" });
  });

  bot.action("cards:close", async (ctx) => {
    await ctx.answerCbQuery();
    try { await ctx.editMessageText("Меню закрыто."); } catch {}
  });

  /* ===== Автоуведомления по расписанию =====
     Киев 11:00, 15:00, 19:00, 23:00  => UTC 08:00, 12:00, 16:00, 20:00 */
  const CRON_RULE_UTC = "0 8,12,16,20 * * *";

  nodeSchedule.scheduleJob(CRON_RULE_UTC, async () => {
    try {
      const text = await computeStatusText(true); // force
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
