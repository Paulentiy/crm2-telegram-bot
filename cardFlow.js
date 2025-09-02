import { google } from "googleapis";
import nodeSchedule from "node-schedule";

const SHEET_ID = process.env.SPREADSHEET_ID;
const SA_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;

const THRESHOLD_SLOTS = parseInt(process.env.THRESHOLD_SLOTS ?? "3", 10);
const THRESHOLD_BUFFER_FREE = parseInt(process.env.THRESHOLD_BUFFER_FREE ?? "5", 10);
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN ?? "60", 10);

// Листы из переменной, либо дефолтные
const SHEET_NAMES = JSON.parse(
  process.env.SHEET_NAMES_JSON ||
    '{"dashboard":"Дашборд","main":"Основные карты","buffer":"Буферные карты","ar":"Автореги","reissue":"Перевыпуски","settings":"Settings"}'
);

// Создаём Google Sheets клиент
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(Buffer.from(SA_B64, "base64").toString("utf-8")),
  scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"],
});
const sheets = google.sheets({ version: "v4", auth });

// Читаем данные листа
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

// --- Вычисляем статус ---
// --- Вычисляем статус ---
export async function computeStatusText() {
  const main = await readSheet(SHEET_NAMES.main);
  
  // Функция для безопасного получения индекса колонки
  const idx = (header, colName) => {
    const index = header.indexOf(colName);
    if (index === -1) return null;  // Возвращаем null, если не нашли колонку
    return index;
  };

  let freeSlots = 0;
  let sumHolds = 0;
  let reissue = 0;

  const iTotal = idx(main.header, "Слоты всего");
  const iUsed = idx(main.header, "Слоты занято");
  const iHold = idx(main.header, "Холды $");
  const iStat = idx(main.header, "Статус");

  if (main.rows.length && iTotal !== null && iUsed !== null) {
    for (const r of main.rows) {
      const total = parseInt(r[iTotal] || "0", 10);
      const used = parseInt(r[iUsed] || "0", 10);
      freeSlots += Math.max(total - used, 0);
      if (iHold !== null) sumHolds += parseFloat((r[iHold] || "0").replace(",", "."));
      if (iStat !== null && (r[iStat] || "").trim() === "Перевыпуск") reissue++;
    }
  }

  const buffer = await readSheet(SHEET_NAMES.buffer);
  const iBufStatus = idx(buffer.header, "Статус");
  const freeBuffer = (buffer.rows.length && iBufStatus !== null)
    ? buffer.rows.filter((r) => (r[iBufStatus] || "") === "Свободна").length
    : 0;

  const alerts = [];
  if (freeSlots < THRESHOLD_SLOTS) alerts.push(`Мало свободных слотов: ${freeSlots} (< ${THRESHOLD_SLOTS})`);
  if (freeBuffer < THRESHOLD_BUFFER_FREE) alerts.push(`Мало свободных буферок: ${freeBuffer} (< ${THRESHOLD_BUFFER_FREE})`);

  let text =
    `📊 *Статус карт*\n` +
    `Свободные слоты: *${freeSlots}*\n` +
    `Свободные буферки: *${freeBuffer}*\n` +
    `Зависшие холды: *$${sumHolds.toFixed(2)}*\n` +
    `Карт к перевыпуску: *${reissue}*`;

  if (alerts.length) text += `\n\n⚠️ ${alerts.join(" | ")}`;
  if (!main.rows.length && !buffer.rows.length) {
    text += `\n\nℹ️ Таблица пустая — всё ок, считаю нули. Можешь начать заполнять листы.`;
  }
  return text;
}


  const buffer = await readSheet(SHEET_NAMES.buffer);
  const iBufStatus = buffer.header.indexOf("Статус");
  const freeBuffer = buffer.rows.filter((r) => (r[iBufStatus] ?? "") === "Свободна").length;

  const alerts = [];
  if (freeSlots < THRESHOLD_SLOTS) alerts.push(`Мало свободных слотов: ${freeSlots} (< ${THRESHOLD_SLOTS})`);
  if (freeBuffer < THRESHOLD_BUFFER_FREE) alerts.push(`Мало свободных буферок: ${freeBuffer} (< ${THRESHOLD_BUFFER_FREE})`);

  let text =
    `📊 *Статус карт*\n` +
    `Свободные слоты: *${freeSlots}*\n` +
    `Свободные буферки: *${freeBuffer}*\n` +
    `Зависшие холды: *$${sumHolds.toFixed(2)}*\n` +
    `Карт к перевыпуску: *${reissue}*`;

  if (alerts.length) text += `\n\n⚠️ ${alerts.join(" | ")}`;

  return text;
}

// --- Регистрация команд Telegraf ---
export function registerCardFlow(bot) {
  // /status
  bot.command("status", async (ctx) => {
    try {
      const text = await computeStatusText();
      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error(e);
      await ctx.reply("Ошибка при получении статуса ❌");
    }
  });

  // Автоуведомления
  nodeSchedule.scheduleJob(`*/${CHECK_INTERVAL_MIN} * * * *`, async () => {
    try {
      const text = await computeStatusText();
      await bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("auto notify error", e);
    }
  });
}
