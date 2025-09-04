// cardFlow.js

import { google } from "googleapis";
import nodeSchedule from "node-schedule";
import { Markup } from "telegraf";

/* ===== ENV ===== */
const SHEET_ID = process.env.CARDS_SPREADSHEET_ID || process.env.SPREADSHEET_ID;           // ID таблицы Card_Flow_Manager (или общий, если один)
const SA_B64   = process.env.GOOGLE_SERVICE_ACCOUNT_B64;

const THRESHOLD_SLOTS       = parseInt(process.env.THRESHOLD_SLOTS ?? "3", 10);
const THRESHOLD_BUFFER_FREE = parseInt(process.env.THRESHOLD_BUFFER_FREE ?? "5", 10);

const SHEET_NAMES = {
  dashboard: "Дашборд",
  main: "Основные карты",
  buffer: "Буферные карты",
  ar: "Автореги",
  reissue: "Перевыпуски",
  settings: "Settings"
};

/* ===== Google Sheets client ===== */
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(Buffer.from(SA_B64, "base64").toString("utf-8")),
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
  ],
});
const sheets = google.sheets({ version: "v4", auth });

/* ===== helpers ===== */
async function readSheet(title) {
  const range = `'${title}'!A1:Z2000`;
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range,
    });
    const [header = [], ...rows] = data.values ?? [];
    return { header, rows };
  } catch {
    return { header: [], rows: [] };
  }
}
function safeIdx(header, name) {
  const i = header.indexOf(name);
  return i >= 0 ? i : null;
}

/* ===== Settings: подписчики ===== */
async function ensureSettingsSheet() {
  // есть ли лист
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = (meta.data.sheets || []).some(
    (s) => s.properties?.title === SHEET_NAMES.settings
  );
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_NAMES.settings } } }],
      },
    });
  }
  // есть ли заголовки
  const { header } = await readSheet(SHEET_NAMES.settings);
  if (!header.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_NAMES.settings}'!A1:E1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          "chat_id",
          "username",
          "threshold_slots",
          "threshold_buffer_free",
          "is_admin",
        ]],
      },
    });
  }
}

async function listSubs() {
  await ensureSettingsSheet();
  const { header, rows } = await readSheet(SHEET_NAMES.settings);
  const iChat = header.indexOf("chat_id");
  const iUser = header.indexOf("username");
  const iTS   = header.indexOf("threshold_slots");
  const iTB   = header.indexOf("threshold_buffer_free");
  const iAdm  = header.indexOf("is_admin");

  const out = [];
  for (const r of rows) {
    const chat_id = r[iChat];
    if (!chat_id) continue;
    out.push({
      chat_id: String(chat_id),
      username: r[iUser] || "",
      ts: parseInt(r[iTS] || THRESHOLD_SLOTS, 10),
      tb: parseInt(r[iTB] || THRESHOLD_BUFFER_FREE, 10),
      admin: String(r[iAdm] || "").toLowerCase() === "true",
    });
  }
  return out;
}

async function upsertSub(chatId, username) {
  await ensureSettingsSheet();
  const { header, rows } = await readSheet(SHEET_NAMES.settings);
  const iChat = header.indexOf("chat_id");
  let   iUser = header.indexOf("username");

  // если нет колонки username — создадим в B1
  if (iUser === -1) {
    iUser = 1; // колонка B
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_NAMES.settings}'!B1`,
      valueInputOption: "RAW",
      requestBody: { values: [["username"]] },
    });
  }

  let rowIndex = -1; // 1-based
  rows.forEach((r, i) => {
    if (String(r[iChat]) === String(chatId)) rowIndex = i + 2;
  });
  const colUser = String.fromCharCode("A".charCodeAt(0) + iUser);

  if (rowIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_NAMES.settings}'!A1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[String(chatId), username || "", "", "", ""]],
      },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_NAMES.settings}'!${colUser}${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[username || ""]] },
    });
  }
}

async function removeSub(chatId) {
  await ensureSettingsSheet();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = meta.data.sheets.find(
    (s) => s.properties.title === SHEET_NAMES.settings
  );
  const sheetId = sheet.properties.sheetId;

  const { header, rows } = await readSheet(SHEET_NAMES.settings);
  const iChat = header.indexOf("chat_id");

  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][iChat]) === String(chatId)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: [
            {
              deleteDimension: {
                range: { sheetId, dimension: "ROWS", startIndex: i + 1, endIndex: i + 2 },
              },
            },
          ],
        },
      });
      break;
    }
  }
}

/* ===== Быстрые метрики (с новой логикой статуса) ===== */
async function quickStats() {
  // Основные карты
  const main = await readSheet(SHEET_NAMES.main);
  const iTotal = safeIdx(main.header, "Слоты всего");
  const iUsed  = safeIdx(main.header, "Слоты занято");
  const iHold  = safeIdx(main.header, "Холды $");
  const iStat  = safeIdx(main.header, "Статус");

  let freeSlots = 0, sumHolds = 0, reissue = 0;
  if (main.rows.length && iTotal !== null && iUsed !== null) {
    for (const r of main.rows) {
      const total = parseInt(r[iTotal] || "0", 10);
      const used  = parseInt(r[iUsed]  || "0", 10);
      freeSlots  += Math.max(total - used, 0);

      if (iHold !== null) {
        const v = String(r[iHold] || "0").replace(",", ".");
        const num = parseFloat(v);
        if (!isNaN(num)) sumHolds += num;
      }
      if (iStat !== null) {
        const st = String(r[iStat] || "").trim();
        if (st === "К перевыпуску" || st === "Перевыпуск") reissue++; // back-compat
      }
    }
  }

  // Буферные карты
  const buf = await readSheet(SHEET_NAMES.buffer);
  const iBufStatus = safeIdx(buf.header, "Статус");
  const freeBuffer = (buf.rows.length && iBufStatus !== null)
    ? buf.rows.filter(r => String(r[iBufStatus] || "").trim() === "Свободна").length
    : 0;

  return { freeSlots, sumHolds: +sumHolds.toFixed(2), freeBuffer, reissue };
}

/* ===== Статус (подробный текст) ===== */
export async function computeStatusText() {
  const main = await readSheet(SHEET_NAMES.main);
  const iTotal = safeIdx(main.header, "Слоты всего");
  const iUsed  = safeIdx(main.header, "Слоты занято");
  const iHold  = safeIdx(main.header, "Холды $");
  const iStat  = safeIdx(main.header, "Статус");

  let freeSlots = 0, sumHolds = 0, reissue = 0;
  if (main.rows.length && iTotal !== null && iUsed !== null) {
    for (const r of main.rows) {
      const total = parseInt(r[iTotal] || "0", 10);
      const used  = parseInt(r[iUsed]  || "0", 10);
      freeSlots  += Math.max(total - used, 0);

      if (iHold !== null) {
        const v = String(r[iHold] || "0").replace(",", ".");
        const num = parseFloat(v);
        if (!isNaN(num)) sumHolds += num;
      }
      if (iStat !== null) {
        const st = String(r[iStat] || "").trim();
        if (st === "К перевыпуску" || st === "Перевыпуск") reissue++;
      }
    }
  }

  const buffer     = await readSheet(SHEET_NAMES.buffer);
  const iBufStatus = safeIdx(buffer.header, "Статус");
  const freeBuffer = (buffer.rows.length && iBufStatus !== null)
    ? buffer.rows.filter(r => String(r[iBufStatus] || "").trim() === "Свободна").length
    : 0;

  const alerts = [];
  if (freeSlots  < THRESHOLD_SLOTS)
    alerts.push(`Мало свободных слотов: ${freeSlots} (< ${THRESHOLD_SLOTS})`);
  if (freeBuffer < THRESHOLD_BUFFER_FREE)
    alerts.push(`Мало свободных буферок: ${freeBuffer} (< ${THRESHOLD_BUFFER_FREE})`);

  let text =
    `📊 *Статус карт*\n` +
    `Свободные слоты: *${freeSlots}*\n` +
    `Свободные буферки: *${freeBuffer}*\n` +
    `Зависшие холды: *$${sumHolds.toFixed(2)}*\n` +
    `Карт к перевыпуску: *${reissue}*`;

  if (alerts.length) text += `\n\n⚠️ ${alerts.join(" | ")}`;
  if (!main.rows.length && !buffer.rows.length) {
    text += `\n\nℹ️ Таблица пустая — считаю нули. Можно начинать заполнять листы.`;
  }
  return text;
}

/* ===== Telegraf integration (меню «Карты») ===== */
export function registerCardFlow(bot) {
  const menu = () =>
    Markup.inlineKeyboard([
      [Markup.button.callback("📊 Статус", "cards:status")],
      [Markup.button.callback("🔔 Подписаться", "cards:sub"), Markup.button.callback("🔕 Отписаться", "cards:unsub")],
      [Markup.button.callback("⚡ Проверить сейчас", "cards:checknow")],
      [Markup.button.callback("🧩 Слоты", "cards:slots"), Markup.button.callback("🧩 Буферки", "cards:buffers"), Markup.button.callback("🧩 Перевыпуск", "cards:reissue")],
      [Markup.button.callback("⬅️ Закрыть", "cards:close")],
    ]);

  // Главная кнопка
  bot.hears("💳 Карты", async (ctx) => {
    await ctx.reply("Выбери действие по картам:", menu());
  });

  // Статус
  bot.action("cards:status", async (ctx) => {
    await ctx.answerCbQuery();
    const text = await computeStatusText();
    await ctx.editMessageText(text, { parse_mode: "Markdown", ...menu() });
  });

  // Подписка / Отписка
  bot.action("cards:sub", async (ctx) => {
    await ctx.answerCbQuery();
    await upsertSub(ctx.chat.id, ctx.from?.username || "");
    await ctx.reply("Подписал на автоуведомления ✅", menu());
  });

  bot.action("cards:unsub", async (ctx) => {
    await ctx.answerCbQuery();
    await removeSub(ctx.chat.id);
    await ctx.reply("Отписал от автоуведомлений ✅", menu());
  });

  // Ручная рассылка (только админ)
  bot.action("cards:checknow", async (ctx) => {
    await ctx.answerCbQuery();
    const subs = await listSubs();
    const me = String(ctx.chat.id);
    const isAdmin = subs.some((s) => s.chat_id === me && s.admin);
    if (!isAdmin) return ctx.reply("Только для админов.", menu());

    const text = await computeStatusText();
    for (const s of subs) {
      try {
        await ctx.telegram.sendMessage(Number(s.chat_id), text, { parse_mode: "Markdown" });
      } catch (e) {
        console.error("send fail", s.chat_id, e?.message || e);
      }
    }
    await ctx.reply("Разослал ✅", menu());
  });

  // Быстрые метрики
  bot.action("cards:slots", async (ctx) => {
    await ctx.answerCbQuery();
    const { freeSlots } = await quickStats();
    await ctx.reply(`Свободные слоты: *${freeSlots}*`, { parse_mode: "Markdown", ...menu() });
  });
  bot.action("cards:buffers", async (ctx) => {
    await ctx.answerCbQuery();
    const { freeBuffer } = await quickStats();
    await ctx.reply(`Свободные буферки: *${freeBuffer}*`, { parse_mode: "Markdown", ...menu() });
  });
  bot.action("cards:reissue", async (ctx) => {
    await ctx.answerCbQuery();
    const { reissue } = await quickStats();
    await ctx.reply(`Карт к перевыпуску: *${reissue}*`, { parse_mode: "Markdown", ...menu() });
  });

  bot.action("cards:close", async (ctx) => {
    await ctx.answerCbQuery();
    try { await ctx.editMessageText("Меню закрыто."); } catch {}
  });

  // /status на всякий
  bot.command("status", async (ctx) => {
    try {
      const text = await computeStatusText();
      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error(e);
      await ctx.reply("Ошибка при получении статуса ❌");
    }
  });

  // Автоуведомления в 11:00, 15:00, 19:00, 23:00 по Киеву (UTC -> 08,12,16,20)
  const CRON_RULE_UTC = '0 8,12,16,20 * * *';
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

// ===== ТЕСТ ЧТЕНИЯ ТАБЛИЦЫ =====
async function testReadMainCards() {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(
        Buffer.from(SA_B64, "base64").toString("utf8")
      ),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAMES.main}!A1:J3`, // первые 3 строки из "Основные карты"
    });

    console.log("=== TEST READ ===");
    console.log(res.data.values);
  } catch (e) {
    console.error("Ошибка при тестовом чтении:", e.message, e);
  }
}

// Вызов теста при старте
testReadMainCards();
console.log("📑 Листы:", SHEET_NAMES);

