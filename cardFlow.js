import { google } from "googleapis";
import nodeSchedule from "node-schedule";
import { Markup } from "telegraf";  

const SHEET_ID = process.env.SPREADSHEET_ID;
const SA_B64   = process.env.GOOGLE_SERVICE_ACCOUNT_B64;

const THRESHOLD_SLOTS       = parseInt(process.env.THRESHOLD_SLOTS ?? "3", 10);
const THRESHOLD_BUFFER_FREE = parseInt(process.env.THRESHOLD_BUFFER_FREE ?? "5", 10);
const CHECK_INTERVAL_MIN    = parseInt(process.env.CHECK_INTERVAL_MIN ?? "60", 10);

const SHEET_NAMES = JSON.parse(
  process.env.SHEET_NAMES_JSON ||
  '{"dashboard":"Дашборд","main":"Основные карты","buffer":"Буферные карты","ar":"Автореги","reissue":"Перевыпуски","settings":"Settings"}'
);

// --- Google Sheets client ---
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(Buffer.from(SA_B64, "base64").toString("utf-8")),
  scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"],
});
const sheets = google.sheets({ version: "v4", auth });

// --- utils to read sheet safely ---
async function readSheet(title) {
  const range = `'${title}'!A1:Z2000`;
  try {
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
    const [header = [], ...rows] = data.values ?? [];
    return { header, rows };
  } catch {
    return { header: [], rows: [] };
  }
}

const safeIdx = (header, colName) => {
  const i = header.indexOf(colName);
  return i >= 0 ? i : null;
};

// --- STATUS ---
export async function computeStatusText() {
  // Основные карты
  const main = await readSheet(SHEET_NAMES.main);
  const iTotal = safeIdx(main.header, "Слоты всего");
  const iUsed  = safeIdx(main.header, "Слоты занято");
  const iHold  = safeIdx(main.header, "Холды $");
  const iStat  = safeIdx(main.header, "Статус");

  let freeSlots = 0;
  let sumHolds  = 0;
  let reissue   = 0;

  if (main.rows.length && iTotal !== null && iUsed !== null) {
    for (const r of main.rows) {
      const total = parseInt(r[iTotal] || "0", 10);
      const used  = parseInt(r[iUsed]  || "0", 10);
      freeSlots  += Math.max(total - used, 0);
      if (iHold !== null) sumHolds += parseFloat(String(r[iHold] || "0").replace(",", "."));
      if (iStat !== null && String(r[iStat] || "").trim() === "Перевыпуск") reissue++;
    }
  }

  // Буферные карты
  const buffer     = await readSheet(SHEET_NAMES.buffer);
  const iBufStatus = safeIdx(buffer.header, "Статус");
  const freeBuffer = (buffer.rows.length && iBufStatus !== null)
    ? buffer.rows.filter(r => String(r[iBufStatus] || "").trim() === "Свободна").length
    : 0;

  // Alerts
  const alerts = [];
  if (freeSlots  < THRESHOLD_SLOTS)       alerts.push(`Мало свободных слотов: ${freeSlots} (< ${THRESHOLD_SLOTS})`);
  if (freeBuffer < THRESHOLD_BUFFER_FREE) alerts.push(`Мало свободных буферок: ${freeBuffer} (< ${THRESHOLD_BUFFER_FREE})`);

  // Text
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

// --- Telegraf integration ---
export function registerCardFlow(bot) {
  // РЕНДЕР МЕНЮ «Карты»
  const cardsMenu = () =>
    Markup.inlineKeyboard([
      [Markup.button.callback('📊 Статус', 'cards:status')],
      // позже сюда добавим: 'Подписаться', 'Отписаться', 'Проверить сейчас'
      [Markup.button.callback('⬅️ Закрыть', 'cards:close')]
    ]);

  // Кнопка в клавиатуре: «💳 Карты»
  bot.hears('💳 Карты', async (ctx) => {
    await ctx.reply('Выбери действие по картам:', cardsMenu());
  });

  // Inline-обработчики
  bot.action('cards:status', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const text = await computeStatusText();
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...cardsMenu() });
    } catch (e) {
      console.error(e);
      await ctx.answerCbQuery('Ошибка', { show_alert: true });
    }
  });

  bot.action('cards:close', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      await ctx.editMessageText('Меню закрыто.');
    } catch {}
  });

  // Команда /status пусть тоже остаётся (на всякий)
  bot.command("status", async (ctx) => {
    try {
      const text = await computeStatusText();
      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error(e);
      await ctx.reply("Ошибка при получении статуса ❌");
    }
  });

  // Автоуведомления по ADMIN_CHAT_ID (если указан)
  if (process.env.ADMIN_CHAT_ID) {
    nodeSchedule.scheduleJob(`*/${CHECK_INTERVAL_MIN} * * * *`, async () => {
      try {
        const text = await computeStatusText();
        await bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID, text, { parse_mode: "Markdown" });
      } catch (e) {
        console.error("auto notify error", e);
      }
    });
  }
}
