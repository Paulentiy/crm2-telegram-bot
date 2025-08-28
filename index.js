import express from 'express';
import { Telegraf, Markup, session } from 'telegraf';
import { google } from 'googleapis';

/** ====== ENV ====== **/
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
const SHEET_EXPENSES = 'Расходы';       // A:Дата B:Платёжка C:Тип D:GEO E:Сумма F:Валюта G:USD H:Комментарий
const SHEET_TYPES    = 'Справочники';   // A2:A — Тип расхода
const SHEET_RATES    = 'Курсы';         // A: код валюты, B: курс к USD (1 USD = 1)
const SHEET_META     = 'BotMeta';       // служебный лист: A user_id, B row_number, C ISO ts

/** ====== CACHE ====== **/
const cache = new Map();
const setCache = (k, v, ms = 10 * 60 * 1000) => cache.set(k, { v, exp: Date.now() + ms });
const getCache = (k) => { const it = cache.get(k); if (!it || Date.now() > it.exp) { cache.delete(k); return null; } return it.v; };

/** ====== TEXTS & KEYBOARDS ====== **/
const HELP_TEXT =
`Привет! Я бот для внесения расходов в CRM2.

Кнопки:
• ➕ Добавить расход — пошаговый мастер
• 📊 Статистика — суммы в USD (сегодня/7дн/месяц)
• ↩️ Отменить последнюю — отмена вашей последней записи
• 📋 Типы / 💱 Валюты — списки из «Справочники» и «Курсы»

Формат (если вручную): 
/exp Дата; Платёжка; Тип; GEO; Сумма; Валюта; Коммент
Пример: /exp ; AdvCash; Прокси; UA; 120; USD; тест`;

const mainKeyboard = () =>
  Markup.keyboard([
    ['➕ Добавить расход', '📊 Статистика'],
    ['📋 Типы', '💱 Валюты'],
    ['↩️ Отменить последнюю', 'ℹ️ Помощь']
  ]).resize().persistent();

const cancelKeyboard = () =>
  Markup.keyboard([['❌ Отмена ввода']]).resize();

/** ====== REGEX ТРИГГЕРЫ (устойчивые к эмодзи/пробелам/регистру) ====== **/
const RX_ADD     = [/^(\+|➕)?\s*добавить\s+расход$/i];
const RX_TYPES   = [/^(📋)?\s*типы$/i];
const RX_CURR    = [/^(💱)?\s*валюты$/i, /^currencies$/i];
const RX_STATS   = [/^(📊)?\s*статистика$/i];
const RX_UNDO    = [/^(↩️)?\s*отменить\s+последнюю$/i];
const RX_HELP    = [/^(ℹ️)?\s*помощь$/i, /^help$/i];
const RX_CANCEL  = [/^(❌)?\s*отмена\s+ввода$/i];

/** ====== HELPERS ====== **/
function ddmmyyyy(d){
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yy = d.getFullYear();
  return `${dd}.${mm}.${yy}`;
}
function parseDDMMYYYY(s){
  const m = String(s||'').trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) throw new Error('Дата должна быть ДД.ММ.ГГГГ или пусто');
  const d = new Date(+m[3], +m[2]-1, +m[1]);
  if (isNaN(d.getTime())) throw new Error('Некорректная дата');
  return d;
}
async function ensureMetaSheet(){
  const info = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const has = (info.data.sheets || []).some(s => s.properties?.title === SHEET_META);
  if (!has){
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_META } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_META}!A1:C1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['user_id','row','ts']] }
    });
  }
}

/** ====== LOOKUPS ====== **/
async function getTypes(force=false){
  if (!force){ const c = getCache('types'); if (c) return c; }
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_TYPES}!A2:A` });
  const arr = (res.data.values || []).flat().map(v => String(v).trim()).filter(Boolean);
  setCache('types', arr);
  return arr;
}
async function getCurrencies(force=false){
  if (!force){ const c = getCache('curr'); if (c) return c; }
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_RATES}!A2:A` });
  let arr = (res.data.values || []).flat().map(v => String(v).trim().toUpperCase()).filter(Boolean);
  if (arr.length === 0){
    const hdr = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_RATES}!1:1` });
    const header = (hdr.data.values?.[0] || []).map(s => String(s).trim().toLowerCase());
    const aliases = ['валюта','currency','curr','code','код'];
    const idx = header.findIndex(h => aliases.includes(h));
    if (idx >= 0){
      const col = String.fromCharCode('A'.charCodeAt(0) + idx);
      const res2 = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_RATES}!${col}2:${col}` });
      arr = (res2.data.values || []).flat().map(v => String(v).trim().toUpperCase()).filter(Boolean);
    }
  }
  if (arr.length === 0) throw new Error('В «Курсы» нет списка валют. Заполни A2:A (USD, EUR, …).');
  setCache('curr', arr);
  return arr;
}
async function getRatesMap(){
  const c = getCache('rates'); if (c) return c;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_RATES}!A2:B` });
  const map = {};
  for (const row of (res.data.values || [])){
    const code = String(row[0]||'').trim().toUpperCase();
    const rate = Number(String(row[1]||'').replace(',', '.'));
    if (code) map[code] = rate > 0 ? rate : (code === 'USD' ? 1 : NaN);
  }
  if (!map.USD) map.USD = 1;
  setCache('rates', map);
  return map;
}

/** ====== AUTOFIX & VALIDATION ====== **/
async function normalizeType(raw){
  const types = await getTypes();
  const t = String(raw||'').trim();
  const found = types.find(x => x.toLowerCase() === t.toLowerCase());
  return found || (t ? (t[0].toUpperCase() + t.slice(1).toLowerCase()) : t);
}
function normalizeCurr(raw){ return String(raw||'').trim().toUpperCase(); }
function normalizeDate(raw){ const s = String(raw||'').trim(); return s ? parseDDMMYYYY(s) : new Date(); }

async function validateRow([date, pay, type, geo, amt, curr]){
  const types = await getTypes();
  const currencies = await getCurrencies();
  const errs = [];

  if (!(date instanceof Date) || isNaN(date.getTime())) errs.push('Некорректная дата');
  if (!pay) errs.push('Платёжка не может быть пустой');
  const typeOk = types.some(t => t.toLowerCase() === String(type||'').trim().toLowerCase());
  if (!typeOk) errs.push(`Тип расхода не из списка: «${type}». Допустимо: ${types.join(', ')}`);
  const currClean = String(curr||'').trim().toUpperCase();
  if (!currencies.includes(currClean)) errs.push(`Валюта не из «Курсы»: «${currClean}». Допустимо: ${currencies.join(', ')}`);
  if (!(Number(amt) > 0)) errs.push('Сумма должна быть > 0');

  if (errs.length) throw new Error(errs.join('\n'));
}

/** ====== APPEND / UNDO ====== **/
async function appendExpenseRow(userId, [date, pay, type, geo, amt, curr, comment]){
  const values = [[ ddmmyyyy(date), pay, type, geo, amt, curr, '', comment ]];
  const resp = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_EXPENSES}!A:H`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });
  const updated = resp.data.updates?.updatedRange || '';
  const m = updated.match(/!(?:[A-Z]+)(\d+):/);
  const rowNumber = m ? Number(m[1]) : null;

  await ensureMetaSheet();
  if (rowNumber){
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_META}!A:C`,
      valueInputOption: 'RAW',
      requestBody: { values: [[String(userId), rowNumber, new Date().toISOString()]] }
    });
  }
  return rowNumber;
}
async function getSheetIdByTitle(title){
  const info = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sh = (info.data.sheets || []).find(s => s.properties?.title === title);
  if (!sh) throw new Error('Нет листа: ' + title);
  return sh.properties.sheetId;
}
async function undoLastForUser(userId){
  await ensureMetaSheet();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_META}!A:C`
  });
  const rows = (res.data.values || []).slice(1).filter(r => r[0] === String(userId));
  if (!rows.length) return { ok:false, reason:'Нет записей для отмены.' };

  const last = rows[rows.length - 1];
  const rowNumber = Number(last[1] || 0);
  if (!(rowNumber > 1)) return { ok:false, reason:'Некорректный номер строки.' };

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{
      deleteDimension: {
        range: {
          sheetId: await getSheetIdByTitle(SHEET_EXPENSES),
          dimension: 'ROWS',
          startIndex: rowNumber - 1,
          endIndex: rowNumber
        }
      }
    }] }
  });
  return { ok:true, row: rowNumber };
}

/** ====== STATS ====== **/
async function loadExpensesAtoG(){
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_EXPENSES}!A2:G`
  });
  return res.data.values || [];
}
function parseDateCell(s){ try { return parseDDMMYYYY(s); } catch { return null; } }
async function getRatesOrEmpty(){ try { return await getRatesMap(); } catch { return {}; } }
async function getRatesMap(){
  const c = getCache('rates'); if (c) return c;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_RATES}!A2:B` });
  const map = {};
  for (const row of (res.data.values || [])){
    const code = String(row[0]||'').trim().toUpperCase();
    const rate = Number(String(row[1]||'').replace(',', '.'));
    if (code) map[code] = rate > 0 ? rate : (code === 'USD' ? 1 : NaN);
  }
  if (!map.USD) map.USD = 1;
  setCache('rates', map);
  return map;
}
async function sumUSD(start, end){
  const rows = await loadExpensesAtoG();
  const rates = await getRatesOrEmpty();
  let sum = 0;
  for (const r of rows){
    const d = parseDateCell(r[0]); if (!d) continue;
    if (d < start || d >= end) continue;
    const amt = Number(String(r[4]||'').replace(',', '.')) || 0;
    const curr = String(r[5]||'').trim().toUpperCase();
    const usdCell = Number(String(r[6]||'').replace(',', '.')) || NaN;
    if (!isNaN(usdCell)) sum += usdCell;
    else if (amt > 0 && curr && rates[curr] > 0) sum += amt * rates[curr];
  }
  return sum;
}
function startOfToday(){ const d = new Date(); d.setHours(0,0,0,0); return d; }
function addDays(d, n){ const x = new Date(d); x.setDate(x.getDate()+n); return x; }
function startOfMonth(){ const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); }

/** ====== BOT ====== **/
const bot = new Telegraf(TELEGRAM_TOKEN, { handlerTimeout: 30000 });
bot.use(session());

// простое логирование входящих текстов для диагностики
bot.on('text', (ctx, next) => { console.log('TEXT:', ctx.message.text); return next(); });

// анти-дубли по update_id
const seen = new Map(); const seenTTLms = 10*60*1000;
setInterval(() => { const now = Date.now(); for (const [k,t] of seen) if (now-t>seenTTLms) seen.delete(k); }, 60000);
bot.use((ctx, next) => { const uid = ctx.update?.update_id; if (uid!=null){ if (seen.has(uid)) return; seen.set(uid, Date.now()); } return next(); });

// Главное меню
async function showMenu(ctx, text = 'Выберите действие:'){ return ctx.reply(text, mainKeyboard()); }

bot.start(async (ctx) => { await ctx.reply(HELP_TEXT, mainKeyboard()); });
bot.help(async (ctx)  => { await ctx.reply(HELP_TEXT, mainKeyboard()); });

bot.hears(RX_TYPES, async (ctx) => {
  const types = await getTypes();
  await ctx.reply('Типы расхода:\n• ' + types.join('\n• '), mainKeyboard());
});
bot.hears(RX_CURR, async (ctx) => {
  try{
    const curr = await getCurrencies();
    await ctx.reply('Доступные валюты:\n• ' + curr.join('\n• '), mainKeyboard());
  }catch(e){
    await ctx.reply('❌ ' + e.message, mainKeyboard());
  }
});
bot.hears(RX_STATS, async (ctx) => {
  await ctx.reply('Что показать?', Markup.inlineKeyboard([
    [ Markup.button.callback('📅 Сегодня', 'stats:day') ],
    [ Markup.button.callback('🗓 7 дней',  'stats:week') ],
    [ Markup.button.callback('📆 Месяц',  'stats:month') ],
  ]));
});
bot.action('stats:day',  async (ctx) => { await ctx.answerCbQuery(); const s=startOfToday(); const e=addDays(s,1); const x=await sumUSD(s,e); await ctx.editMessageText(`Сумма за сегодня: ${x.toFixed(2)} USD`); });
bot.action('stats:week', async (ctx) => { await ctx.answerCbQuery(); const e=addDays(startOfToday(),1); const s=addDays(e,-7); const x=await sumUSD(s,e); await ctx.editMessageText(`Сумма за 7 дней: ${x.toFixed(2)} USD`); });
bot.action('stats:month',async (ctx) => { await ctx.answerCbQuery(); const s=startOfMonth(); const e=addDays(startOfToday(),1); const x=await sumUSD(s,e); await ctx.editMessageText(`Сумма за месяц: ${x.toFixed(2)} USD`); });

bot.hears(RX_UNDO, async (ctx) => {
  try{
    const r = await undoLastForUser(ctx.from.id);
    if (r.ok) await ctx.reply(`Удалил строку №${r.row}`, mainKeyboard());
    else      await ctx.reply('❌ ' + r.reason, mainKeyboard());
  }catch(e){
    await ctx.reply('❌ ' + (e.message||e), mainKeyboard());
  }
});

bot.hears(RX_HELP, async (ctx) => ctx.reply(HELP_TEXT, mainKeyboard()));

// ===== Мастер "Добавить расход" =====
bot.hears(RX_ADD, async (ctx) => {
  ctx.session.wiz = { step: 'date', data: {} };
  await ctx.reply('Дата (ДД.ММ.ГГГГ) или оставь пусто — возьму сегодня', cancelKeyboard());
});
bot.hears(RX_CANCEL, async (ctx) => {
  ctx.session.wiz = null;
  await showMenu(ctx, 'Ок, отменил ввод.');
});

// обработчик шагов мастера
bot.on('text', async (ctx, next) => {
  if (!ctx.session?.wiz) return next();

  const st = ctx.session.wiz;
  const txt = (ctx.message.text || '').trim();

  try{
    if (st.step === 'date'){
      st.data.date = normalizeDate(txt);
      st.step = 'pay';
      return ctx.reply('Платёжка (например: AdvCash, Capitalist, Card)', cancelKeyboard());
    }
    if (st.step === 'pay'){
      if (!txt) return ctx.reply('Платёжка не может быть пустой. Введите снова.', cancelKeyboard());
      st.data.pay = txt;
      st.step = 'type';
      const types = await getTypes();
      const kb = Markup.keyboard([...types.map(t=>[t]), ['❌ Отмена ввода']]).resize().oneTime();
      return ctx.reply('Тип расхода (выберите из списка или введите):', kb);
    }
    if (st.step === 'type'){
      st.data.type = await normalizeType(txt);
      st.step = 'geo';
      return ctx.reply('GEO (две буквы, например UA, KZ, PL)', cancelKeyboard());
    }
    if (st.step === 'geo'){
      if (!txt) return ctx.reply('GEO не может быть пустым.', cancelKeyboard());
      st.data.geo = txt.toUpperCase();
      st.step = 'amt';
      return ctx.reply('Сумма (число, точка/запятая допустимы)', cancelKeyboard());
    }
    if (st.step === 'amt'){
      const n = Number(txt.replace(',', '.'));
      if (!(n > 0)) return ctx.reply('Сумма должна быть > 0. Введите снова.', cancelKeyboard());
      st.data.amt = n;
      st.step = 'curr';
      const curr = await getCurrencies();
      const kb = Markup.keyboard([...curr.map(c=>[c]), ['❌ Отмена ввода']]).resize().oneTime();
      return ctx.reply('Валюта (выберите из списка или введите):', kb);
    }
    if (st.step === 'curr'){
      st.data.curr = normalizeCurr(txt);
      st.step = 'comm';
      return ctx.reply('Комментарий (можно пусто):', cancelKeyboard());
    }
    if (st.step === 'comm'){
      st.data.comm = txt;
      const row = [st.data.date, st.data.pay, st.data.type, st.data.geo, st.data.amt, st.data.curr, st.data.comm];
      await validateRow(row);
      const rowNum = await appendExpenseRow(ctx.from.id, row);
      ctx.session.wiz = null;
      const dd = ddmmyyyy(st.data.date);
      await ctx.reply(
        '✅ Добавлено:\n' +
        `Дата: ${dd}\nПлатёжка: ${st.data.pay}\nТип: ${st.data.type}\nGEO: ${st.data.geo}\n` +
        `Сумма: ${st.data.amt}\nВалюта: ${st.data.curr}` + (st.data.comm ? `\nКомментарий: ${st.data.comm}` : '') +
        `\n\nСтрока №${rowNum}. Колонка G (USD) посчитается формулой.`,
        mainKeyboard()
      );
      return;
    }
  }catch(e){
    ctx.session.wiz = null;
    return ctx.reply('❌ ' + (e.message || e), mainKeyboard());
  }
});

// Совместимость: если пришлют /exp …
bot.hears(/^\/exp(?:@[\w_]+)?\s*(.*)$/i, async (ctx) => {
  try {
    const p = (ctx.match?.[1] || '').split(';').map(s=>s.trim()); while (p.length<7) p.push('');
    const [dateStr, pay, typeRaw, geoRaw, amtStr, currRaw, comm] = p;
    const row = [
      normalizeDate(dateStr),
      pay || 'N/A',
      await normalizeType(typeRaw),
      String(geoRaw||'').toUpperCase(),
      Number(String(amtStr||'').replace(',','.')),
      normalizeCurr(currRaw),
      comm
    ];
    await validateRow(row);
    await appendExpenseRow(ctx.from.id, row);
    await ctx.reply('✅ Готово. Запись добавлена.', mainKeyboard());
  } catch (e) {
    await ctx.reply('❌ ' + e.message + '\nФормат: /exp Дата; Платёжка; Тип; GEO; Сумма; Валюта; Комментарий', mainKeyboard());
  }
});

// общий fallback: если не кнопка и не мастер — показываем меню
bot.on('text', async (ctx) => showMenu(ctx));

/** ====== SERVER START ====== **/
const app = express();
app.get('/health', (_, res) => res.send('ok'));
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await bot.telegram.setMyCommands([
      { command: 'help', description: 'Как пользоваться' },
      { command: 'types', description: 'Список типов' },
      { command: 'currencies', description: 'Список валют' },
      { command: 'whoami', description: 'Показать user_id' }
    ]);
  } catch {}

  if (WEBHOOK_BASE_URL) {
    const path = '/tg-webhook';
    app.post(path, express.json(), (req, res) => bot.webhookCallback(path)(req, res));
    await bot.telegram.setWebhook(`${WEBHOOK_BASE_URL}${path}`);
    app.listen(PORT, () => console.log('Bot via webhook on', PORT, 'url:', `${WEBHOOK_BASE_URL}${path}`));
  } else {
    await bot.launch(); // long polling
    app.listen(PORT, () => console.log('Bot via long polling on', PORT));
  }
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
})();
