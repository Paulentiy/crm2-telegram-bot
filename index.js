import express from 'express';
import { Telegraf } from 'telegraf';
import { google } from 'googleapis';

/** ====== CONFIG FROM ENV ====== **/
const {
  TELEGRAM_TOKEN,
  SPREADSHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_B64,
  WEBHOOK_BASE_URL // оставь пустым для long polling
} = process.env;

if (!TELEGRAM_TOKEN) throw new Error('Missing TELEGRAM_TOKEN');
if (!SPREADSHEET_ID) throw new Error('Missing SPREADSHEET_ID');
if (!GOOGLE_SERVICE_ACCOUNT_B64) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_B64');

/** ====== GOOGLE SHEETS AUTH ====== **/
const svc = JSON.parse(Buffer.from(GOOGLE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
const auth = new google.auth.JWT(
  svc.client_email,
  null,
  svc.private_key,
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth });

/** ====== SHEET NAMES ====== **/
const SHEET_EXPENSES   = 'Расходы';
const SHEET_TYPES      = 'Справочники';
const SHEET_RATES      = 'Курсы';

/** ====== SIMPLE CACHE ====== **/
const cache = new Map();
const setCache = (k, v, ms = 10 * 60 * 1000) => cache.set(k, { v, exp: Date.now() + ms });
const getCache = (k) => { const it = cache.get(k); if (!it || Date.now() > it.exp) { cache.delete(k); return null; } return it.v; };

/** ====== HELPERS ====== **/
const normCmd = (text) => String(text || '').trim().split(/\s+/)[0].replace(/@[\w_]+$/i, '').toLowerCase();

async function getTypes(force = false) {
  if (!force) { const c = getCache('types'); if (c) return c; }
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_TYPES}!A2:A` });
  const types = (res.data.values || []).flat().map(s => String(s).trim()).filter(Boolean);
  setCache('types', types);
  return types;
}

async function getCurrencies(force = false) {
  if (!force) { const c = getCache('curr'); if (c) return c; }
  let res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_RATES}!A2:A` });
  let arr = (res.data.values || []).flat().map(s => String(s).trim().toUpperCase()).filter(Boolean);
  if (arr.length === 0) {
    const hdr = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_RATES}!1:1` });
    const header = (hdr.data.values?.[0] || []).map(s => String(s).trim().toLowerCase());
    const aliases = ['валюта','currency','curr','code','код'];
    const idx = header.findIndex(h => aliases.includes(h));
    if (idx >= 0) {
      const col = String.fromCharCode('A'.charCodeAt(0) + idx);
      const res2 = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_RATES}!${col}2:${col}` });
      arr = (res2.data.values || []).flat().map(s => String(s).trim().toUpperCase()).filter(Boolean);
    }
  }
  if (arr.length === 0) throw new Error('В «Курсы» нет списка валют. Заполни A2:A (USD, EUR, …).');
  setCache('curr', arr);
  return arr;
}

function parseDDMMYYYY(s) {
  const m = String(s).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) throw new Error('Дата должна быть ДД.MM.ГГГГ или пусто');
  const d = new Date(+m[3], +m[2]-1, +m[1]);
  if (isNaN(d.getTime())) throw new Error('Некорректная дата');
  return d;
}
function parseExpensePayload(payload) {
  const p = String(payload||'').split(';').map(s => s.trim());
  while (p.length < 7) p.push('');
  const [dateStr, pay, type, geo, amtStr, curr, comment] = p;
  const date = dateStr ? parseDDMMYYYY(dateStr) : new Date();
  const amt = Number(String(amtStr||'').replace(',', '.'));
  if (!(amt > 0)) throw new Error('Сумма должна быть > 0');
  return [date, pay, type, (geo||'').toUpperCase(), amt, (curr||'').toUpperCase(), comment];
}
async function validateRow([, , type, , amt, curr]) {
  const types = await getTypes();
  const currencies = await getCurrencies();
  const typeOk = types.some(t => t.toLowerCase() === String(type).trim().toLowerCase());
  const currOk = currencies.includes(String(curr).trim().toUpperCase());
  const errs = [];
  if (!typeOk) errs.push(`Тип расхода не из списка: «${type}». Допустимо: ${types.join(', ')}`);
  if (!currOk) errs.push(`Валюта не из «Курсы»: «${curr}». Допустимо: ${currencies.join(', ')}`);
  if (!(amt > 0)) errs.push('Сумма должна быть > 0');
  if (errs.length) throw new Error(errs.join('\n'));
}
function formatDateForSheet(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth()+1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}
async function appendExpenseRow([date, pay, type, geo, amt, curr, comment]) {
  const values = [[ formatDateForSheet(date), pay, type, geo, amt, curr, '', comment ]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_EXPENSES}!A:H`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });
}

/** ====== TELEGRAM BOT ====== **/
const bot = new Telegraf(TELEGRAM_TOKEN, { handlerTimeout: 30000 });

// анти-дубли
const seen = new Map();
const seenTTLms = 10 * 60 * 1000;
setInterval(() => { const now = Date.now(); for (const [k,t] of seen) if (now - t > seenTTLms) seen.delete(k); }, 60000);

bot.use(async (ctx, next) => {
  const uid = ctx.update?.update_id;
  if (uid != null) { if (seen.has(uid)) return; seen.set(uid, Date.now()); }
  return next();
});

const HELP =
`Привет! Я бот для внесения расходов в CRM2.
/exp Дата; Платёжка; Тип; GEO; Сумма; Валюта; Коммент
Пример: /exp ; AdvCash; Прокси; UA; 120; USD; тест
/types — типы, /currencies — валюты, /whoami — ваш user_id`;

bot.start((ctx) => ctx.reply(HELP));
bot.help((ctx) => ctx.reply(HELP));
bot.command('whoami', (ctx) => ctx.reply(`user_id: ${ctx.from?.id}\nchat_id: ${ctx.chat?.id}`));

bot.command('types', async (ctx) => {
  const cached = getCache('types_text'); if (cached) return ctx.reply(cached);
  await ctx.reply('⏳ Получаю список типов…');
  const types = await getTypes(true);
  const text = 'Типы расхода:\n• ' + types.join('\n• ');
  setCache('types_text', text);
  return ctx.reply(text);
});
bot.command('currencies', async (ctx) => {
  const cached = getCache('curr_text'); if (cached) return ctx.reply(cached);
  await ctx.reply('⏳ Получаю список валют…');
  try {
    const curr = await getCurrencies(true);
    const text = 'Доступные валюты:\n• ' + curr.join('\n• ');
    setCache('curr_text', text);
    return ctx.reply(text);
  } catch (e) {
    return ctx.reply('❌ Не удалось получить валюты: ' + e.message);
  }
});

// /exp … (поддерживает /exp@BotName ...)
bot.hears(/^\/exp(?:@[\w_]+)?\s*(.*)$/i, async (ctx) => {
  try {
    const row = parseExpensePayload(ctx.match?.[1] || '');
    await validateRow(row);
    await appendExpenseRow(row);
    const [date, pay, type, geo, amt, curr, comment] = row;
    await ctx.reply(
      '✅ Добавлено:\n' +
      `Дата: ${formatDateForSheet(date)}\nПлатёжка: ${pay}\nТип: ${type}\nGEO: ${geo}\nСумма: ${amt}\nВалюта: ${curr}` +
      (comment ? `\nКомментарий: ${comment}` : '') +
      '\n\nКолонка G (USD) посчитается формулой.'
    );
  } catch (err) {
    await ctx.reply('❌ ' + err.message + '\nФормат: /exp Дата; Платёжка; Тип; GEO; Сумма; Валюта; Комментарий');
  }
});

bot.on('text', (ctx) => ctx.reply('Не понял. Попробуй /help'));

/** ====== WEB SERVER / START ====== **/
const app = express();
app.get('/health', (_, res) => res.send('ok'));
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await bot.telegram.setMyCommands([
      { command: 'help', description: 'Как пользоваться' },
      { command: 'types', description: 'Список типов расхода' },
      { command: 'currencies', description: 'Список валют' },
      { command: 'whoami', description: 'Показать user_id' }
    ]);
  } catch {}
  if (WEBHOOK_BASE_URL) {
    const path = '/tg-webhook';
    app.use(path, (req, res, next) => bot.webhookCallback(path)(req, res, next));
    await bot.telegram.setWebhook(`${WEBHOOK_BASE_URL}${path}`);
    app.listen(PORT, () => console.log('Bot via webhook on', PORT));
  } else {
    await bot.launch(); // long polling
    app.listen(PORT, () => console.log('Bot via long polling on', PORT));
  }
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
})();
