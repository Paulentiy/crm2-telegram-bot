// index.js — CRM2 bot (Расходы + Прибыль) / RU
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import { google } from 'googleapis';
import { registerCardFlow } from "./cardFlow.js";


/** ====== ENV ====== **/
const {
  TELEGRAM_TOKEN,
  SPREADSHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_B64,
  WEBHOOK_BASE_URL // пусто => long polling
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
const SHEET_EXPENSES = 'Расходы';
const SHEET_INCOME   = 'Доходы';
const SHEET_TYPES    = 'Справочники';
const SHEET_RATES    = 'Курсы';
const SHEET_META     = 'BotMeta'; // user_id | row | ts | sheet

/** ====== CACHE & STATE ====== **/
const cache = new Map();
const setCache = (k, v, ms = 10 * 60 * 1000) => cache.set(k, { v, exp: Date.now() + ms });
const getCache = (k) => { const it = cache.get(k); if (!it || Date.now() > it.exp) { cache.delete(k); return null; } return it.v; };

const wizards = new Map(); // chatId -> { mode:'exp'|'inc', step, data }
const key = (ctx) => String(ctx.chat?.id ?? ctx.from?.id);
const getWiz   = (ctx) => wizards.get(key(ctx));
const setWiz   = (ctx, w) => wizards.set(key(ctx), w);
const clearWiz = (ctx) => wizards.delete(key(ctx));

/** ====== CONSTS ====== **/
const INCOME_STATUSES = ['Ожидает', 'Получено', 'Отклонено'];
const INCOME_TYPES    = ['Пополнение', 'Депозит'];

const HELP_TEXT =
`Привет! Я бот CRM2.

Кнопки:
• ➕ Добавить расход / ➕ Добавить прибыль — пошаговый ввод
• 📊 Статистика — (пока по расходам; расширим)
• ↩️ Отменить последнюю — удалить последнюю запись (любой лист)
• 📋 Типы / 💱 Валюты — списки из «Справочники» и «Курсы»
/whoami — показать ваш user_id`;

const mainKeyboard = () =>
  Markup.keyboard([
    ['➕ Добавить расход', '➕ Добавить прибыль'],
    ['📊 Статистика'],
    ['📋 Типы', '💱 Валюты'],
    ['↩️ Отменить последнюю', 'ℹ️ Помощь']
  ]).resize().persistent();

const cancelKeyboard  = () => Markup.keyboard([['❌ Отмена ввода']]).resize();
const dateKeyboard    = () => Markup.keyboard([['Сегодня'], ['❌ Отмена ввода']]).resize().oneTime();
const commentKeyboard = () => Markup.keyboard([['Без комментария'], ['❌ Отмена ввода']]).resize().oneTime();

/** ====== HELPERS ====== **/
function ddmmyyyy(d){ const dd=String(d.getDate()).padStart(2,'0'); const mm=String(d.getMonth()+1).padStart(2,'0'); const yy=d.getFullYear(); return `${dd}.${mm}.${yy}`; }
function parseDDMMYYYY(s){
  const m=String(s||'').trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if(!m) throw new Error('Дата должна быть ДД.ММ.ГГГГ или «Сегодня»');
  const d=new Date(+m[3],+m[2]-1,+m[1]); if(isNaN(d.getTime())) throw new Error('Некорректная дата'); return d;
}
const isTodayInput = s => /^сегодня$|^today$|^now$/i.test(String(s||'').trim());
const normalizeDate = raw => { const s=String(raw||'').trim(); return (!s || isTodayInput(s)) ? new Date() : parseDDMMYYYY(s); };
const normalizeCurr = raw => String(raw||'').trim().toUpperCase();
const isSkipComment = s => /^(без\s+комментария|пропустить|нет(\s+комментария)?|skip|—|-|–|\.{0,3})$/i.test(String(s||'').trim());

async function getTypes(force=false){
  if(!force){ const c=getCache('types'); if(c) return c; }
  const res=await sheets.spreadsheets.values.get({ spreadsheetId:SPREADSHEET_ID, range:`${SHEET_TYPES}!A2:A` });
  const arr=(res.data.values||[]).flat().map(v=>String(v).trim()).filter(Boolean);
  setCache('types',arr); return arr;
}
async function getCurrencies(force=false){
  if(!force){ const c=getCache('curr'); if(c) return c; }
  const res=await sheets.spreadsheets.values.get({ spreadsheetId:SPREADSHEET_ID, range:`${SHEET_RATES}!A2:A` });
  let arr=(res.data.values||[]).flat().map(v=>String(v).trim().toUpperCase()).filter(Boolean);
  if(arr.length===0) throw new Error('В «Курсы» нет списка валют. Заполни A2:A (USD, EUR, …).');
  setCache('curr',arr); return arr;
}

/** ====== META SHEET ====== **/
async function ensureMetaSheet(){
  const info=await sheets.spreadsheets.get({ spreadsheetId:SPREADSHEET_ID });
  const has=(info.data.sheets||[]).some(s=>s.properties?.title===SHEET_META);
  if(!has){
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId:SPREADSHEET_ID,
      requestBody:{ requests:[{ addSheet:{ properties:{ title:SHEET_META } } }] }
    });
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId:SPREADSHEET_ID, range:`${SHEET_META}!A1:D1`, valueInputOption:'RAW',
    requestBody:{ values:[['user_id','row','ts','sheet']] }
  });
}
async function getSheetIdByTitle(title){
  const info=await sheets.spreadsheets.get({ spreadsheetId:SPREADSHEET_ID });
  const sh=(info.data.sheets||[]).find(s=>s.properties?.title===title);
  if(!sh) throw new Error('Нет листа: '+title);
  return sh.properties.sheetId;
}

/** ====== APPEND ROWS ====== **/
async function appendExpenseRow(userId,[date,pay,type,geo,amt,curr,comment]){
  const resp=await sheets.spreadsheets.values.append({
    spreadsheetId:SPREADSHEET_ID, range:`${SHEET_EXPENSES}!A:H`,
    valueInputOption:'USER_ENTERED', insertDataOption:'INSERT_ROWS',
    requestBody:{ values:[[ddmmyyyy(date),pay,type,geo,amt,curr,'',comment||'']] }
  });
  const upd=resp.data.updates?.updatedRange||''; const m=upd.match(/!(?:[A-Z]+)(\d+):/); const rowNumber=m?Number(m[1]):null;
  await ensureMetaSheet();
  if(rowNumber){
    await sheets.spreadsheets.values.append({
      spreadsheetId:SPREADSHEET_ID, range:`${SHEET_META}!A:D`, valueInputOption:'RAW',
      requestBody:{ values:[[String(userId),rowNumber,new Date().toISOString(),SHEET_EXPENSES]] }
    });
  }
  return rowNumber;
}
async function appendIncomeRow(userId,[date,status,itype,amt,curr,comment]){
  const resp=await sheets.spreadsheets.values.append({
    spreadsheetId:SPREADSHEET_ID, range:`${SHEET_INCOME}!A:G`,
    valueInputOption:'USER_ENTERED', insertDataOption:'INSERT_ROWS',
    requestBody:{ values:[[ddmmyyyy(date),status,itype,amt,curr,'',comment||'']] }
  });
  const upd=resp.data.updates?.updatedRange||''; const m=upd.match(/!(?:[A-Z]+)(\d+):/); const rowNumber=m?Number(m[1]):null;
  await ensureMetaSheet();
  if(rowNumber){
    await sheets.spreadsheets.values.append({
      spreadsheetId:SPREADSHEET_ID, range:`${SHEET_META}!A:D`, valueInputOption:'RAW',
      requestBody:{ values:[[String(userId),rowNumber,new Date().toISOString(),SHEET_INCOME]] }
    });
  }
  return rowNumber;
}
async function undoLastForUser(userId){
  await ensureMetaSheet();
  const res=await sheets.spreadsheets.values.get({ spreadsheetId:SPREADSHEET_ID, range:`${SHEET_META}!A:D` });
  const rows=(res.data.values||[]).slice(1).filter(r=>r[0]===String(userId));
  if(!rows.length) return { ok:false, reason:'Нет записей для отмены.' };
  const last=rows[rows.length-1];
  const rowNumber=Number(last[1]||0);
  const sheetName=last[3]||SHEET_EXPENSES;
  if(!(rowNumber>1)) return { ok:false, reason:'Некорректный номер строки.' };
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId:SPREADSHEET_ID,
    requestBody:{ requests:[{ deleteDimension:{ range:{ sheetId:await getSheetIdByTitle(sheetName), dimension:'ROWS', startIndex:rowNumber-1, endIndex:rowNumber } } }] }
  });
  return { ok:true, row:rowNumber, sheet:sheetName };
}

/** ====== STATS (по расходам, как раньше) ====== **/
async function loadExpensesAtoG(){
  const res=await sheets.spreadsheets.values.get({ spreadsheetId:SPREADSHEET_ID, range:`${SHEET_EXPENSES}!A2:G` });
  return res.data.values||[];
}
function parseDateCell(s){
  const m=String(s||'').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if(m){ const d=new Date(+m[3],+m[2]-1,+m[1]); return isNaN(d.getTime())?null:d; }
  const d=new Date(s); return isNaN(d.getTime())?null:d;
}
async function sumUSD(start,end){
  const rows=await loadExpensesAtoG(); let sum=0;
  for(const r of rows){
    const d=parseDateCell(r[0]); if(!d) continue;
    if(d<start || d>=end) continue;
    const usd=Number(String(r[6]||'').replace(',','.'));
    if(usd>0) sum+=usd;
  }
  return sum;
}
const startOfToday=()=>{ const d=new Date(); d.setHours(0,0,0,0); return d; };
const addDays=(d,n)=>{ const x=new Date(d); x.setDate(x.getDate()+n); return x; };
const startOfMonth=()=>{ const d=new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); };

/** ====== BOT ====== **/
const bot = new Telegraf(TELEGRAM_TOKEN, { handlerTimeout: 30000 });
// Подключаем модуль CardFlow (новые команды + автоуведомления)
registerCardFlow(bot);


// Логи входящих текстов
bot.on('text', (ctx, next) => { console.log('TEXT:', ctx.message.text); return next(); });

// Анти-дубли по update_id
const seen=new Map(); const seenTTL=10*60*1000;
setInterval(()=>{ const now=Date.now(); for(const [k,t] of seen){ if(now-t>seenTTL) seen.delete(k); }},60000);
bot.use((ctx,next)=>{ const id=ctx.update?.update_id; if(id!=null){ if(seen.has(id)) return; seen.set(id,Date.now()); } return next(); });

// Меню/команды
const showMenu=(ctx,text='Выберите действие:')=>ctx.reply(text,mainKeyboard());
bot.start(ctx=>ctx.reply(HELP_TEXT,mainKeyboard()));
bot.help (ctx=>ctx.reply(HELP_TEXT,mainKeyboard()));
bot.command('whoami', ctx=>ctx.reply(`user_id: ${ctx.from.id}\nchat_id: ${ctx.chat.id}`));

bot.hears('📋 Типы', async ctx=>{
  const types=await getTypes(); await ctx.reply('Типы расхода:\n• '+types.join('\n• '), mainKeyboard());
});
bot.hears('💱 Валюты', async ctx=>{
  try{ const curr=await getCurrencies(); await ctx.reply('Валюты:\n• '+curr.join('\n• '), mainKeyboard()); }
  catch(e){ await ctx.reply('❌ '+e.message, mainKeyboard()); }
});

/* ===== Расход: мастер (старый функционал) ===== */
bot.hears('➕ Добавить расход', async ctx=>{
  setWiz(ctx, { mode:'exp', step:'date', data:{} });
  await ctx.reply('Дата (ДД.ММ.ГГГГ) или нажми «Сегодня»', dateKeyboard());
});
bot.hears('❌ Отмена ввода', async ctx=>{ clearWiz(ctx); await ctx.reply('Ок, отменил ввод.', mainKeyboard()); });

bot.on('text', async (ctx, next)=>{
  const st=getWiz(ctx);
  const txt=(ctx.message.text||'').trim();
  if(!st) return next();

  try{
    if(st.mode==='exp'){
      if(st.step==='date'){ st.data.date=normalizeDate(txt); st.step='pay'; setWiz(ctx,st); return ctx.reply('Платёжка (AdvCash, Capitalist, Card)', cancelKeyboard()); }
      if(st.step==='pay'){ if(!txt) return ctx.reply('Платёжка не может быть пустой. Введите снова.', cancelKeyboard()); st.data.pay=txt; st.step='type'; setWiz(ctx,st);
        const types=await getTypes(); const kb=Markup.keyboard([...types.map(t=>[t]),['❌ Отмена ввода']]).resize().oneTime(); return ctx.reply('Тип расхода (выберите из списка или введите):', kb); }
      if(st.step==='type'){ st.data.type=txt; st.step='geo'; setWiz(ctx,st); return ctx.reply('GEO (две буквы, например UA, KZ, PL)', cancelKeyboard()); }
      if(st.step==='geo'){ if(!/^[A-Za-z]{2}$/.test(txt)) return ctx.reply('GEO — две латинские буквы (UA, PL).', cancelKeyboard()); st.data.geo=txt.toUpperCase(); st.step='amt'; setWiz(ctx,st); return ctx.reply('Сумма (число, точка/запятая допустимы)', cancelKeyboard()); }
      if(st.step==='amt'){ const n=Number(txt.replace(',','.')); if(!(n>0)) return ctx.reply('Сумма должна быть > 0. Введите снова.', cancelKeyboard()); st.data.amt=n; st.step='curr'; setWiz(ctx,st);
        const curr=await getCurrencies(); const kb=Markup.keyboard([...curr.map(c=>[c]),['❌ Отмена ввода']]).resize().oneTime(); return ctx.reply('Валюта (выберите из списка или введите):', kb); }
      if(st.step==='curr'){ st.data.curr=normalizeCurr(txt); st.step='comm'; setWiz(ctx,st); return ctx.reply('Комментарий (можно пропустить: «Без комментария»)', commentKeyboard()); }
      if(st.step==='comm'){
        const comm = isSkipComment(txt) ? '' : txt;
        const rowNum=await appendExpenseRow(ctx.from.id,[st.data.date,st.data.pay,st.data.type,st.data.geo,st.data.amt,st.data.curr,comm]);
        clearWiz(ctx);
        const dd=ddmmyyyy(st.data.date);
        return ctx.reply(`✅ Расход добавлен (строка ${rowNum}).
Дата: ${dd}
Платёжка: ${st.data.pay}
Тип: ${st.data.type}
GEO: ${st.data.geo}
Сумма: ${st.data.amt} ${st.data.curr}`, mainKeyboard());
      }
    }

    if(st.mode==='inc'){
      if(st.step==='date'){ st.data.date=normalizeDate(txt); st.step='status'; setWiz(ctx,st);
        const kb=Markup.keyboard([['Ожидает','Получено','Отклонено'],['❌ Отмена ввода']]).resize().oneTime();
        return ctx.reply('Статус прибыли:', kb);
      }
      if(st.step==='status'){ if(!INCOME_STATUSES.includes(txt)) return ctx.reply('Выберите: Ожидает / Получено / Отклонено.', cancelKeyboard()); st.data.status=txt; st.step='itype'; setWiz(ctx,st);
        const kb=Markup.keyboard([['Пополнение','Депозит'],['❌ Отмена ввода']]).resize().oneTime();
        return ctx.reply('Тип прибыли:', kb);
      }
      if(st.step==='itype'){ if(!INCOME_TYPES.includes(txt)) return ctx.reply('Выберите: Пополнение / Депозит.', cancelKeyboard()); st.data.itype=txt; st.step='amt'; setWiz(ctx,st); return ctx.reply('Сумма (число):', cancelKeyboard()); }
      if(st.step==='amt'){ const n=Number(txt.replace(',','.')); if(!(n>0)) return ctx.reply('Сумма должна быть > 0', cancelKeyboard()); st.data.amt=n; st.step='curr'; setWiz(ctx,st);
        const curr=await getCurrencies(); const kb=Markup.keyboard([...curr.map(c=>[c]),['❌ Отмена ввода']]).resize().oneTime(); return ctx.reply('Валюта:', kb); }
      if(st.step==='curr'){ st.data.curr=normalizeCurr(txt); st.step='comm'; setWiz(ctx,st); return ctx.reply('Комментарий (можно пропустить: «Без комментария»)', commentKeyboard()); }
      if(st.step==='comm'){
        const comm = isSkipComment(txt) ? '' : txt;
        const rowNum=await appendIncomeRow(ctx.from.id,[st.data.date, st.data.status, st.data.itype, st.data.amt, st.data.curr, comm]);
        clearWiz(ctx);
        const dd=ddmmyyyy(st.data.date);
        return ctx.reply(`✅ Прибыль добавлена (строка ${rowNum}).
Дата: ${dd}
Статус: ${st.data.status}
Тип: ${st.data.itype}
Сумма: ${st.data.amt} ${st.data.curr}`, mainKeyboard());
      }
    }
  }catch(e){
    console.error(e);
    clearWiz(ctx);
    return ctx.reply('❌ ' + (e.message||e), mainKeyboard());
  }
});

/* Быстрый запуск прибыль/расход */
bot.hears('➕ Добавить прибыль', async ctx=>{
  setWiz(ctx, { mode:'inc', step:'date', data:{} });
  await ctx.reply('Дата (ДД.ММ.ГГГГ) или нажми «Сегодня»', dateKeyboard());
});
bot.hears('📊 Статистика', async (ctx) => {
  await ctx.reply('Что показать?', Markup.inlineKeyboard([
    [Markup.button.callback('📅 Сегодня','stats:day')],
    [Markup.button.callback('🗓 7 дней','stats:week')],
    [Markup.button.callback('📆 Месяц','stats:month')],
  ]));
});
bot.action('stats:day',  async ctx=>{ await ctx.answerCbQuery(); const s=startOfToday(); const e=addDays(s,1); const x=await sumUSD(s,e); await ctx.editMessageText(`Расходы за сегодня: $${x.toFixed(2)}`); });
bot.action('stats:week', async ctx=>{ await ctx.answerCbQuery(); const e=addDays(startOfToday(),1); const s=addDays(e,-7); const x=await sumUSD(s,e); await ctx.editMessageText(`Расходы за 7 дней: $${x.toFixed(2)}`); });
bot.action('stats:month',async ctx=>{ await ctx.answerCbQuery(); const s=startOfMonth(); const e=addDays(startOfToday(),1); const x=await sumUSD(s,e); await ctx.editMessageText(`Расходы за месяц: $${x.toFixed(2)}`); });

/* Undo — удаляет последнюю запись (из «Расходы» или «Доходы») */
bot.hears('↩️ Отменить последнюю', async ctx=>{
  try{
    const r=await undoLastForUser(ctx.from.id);
    if(r.ok) await ctx.reply(`✅ Удалил строку №${r.row} из «${r.sheet}».`);
    else await ctx.reply('❌ '+r.reason);
  }catch(e){ await ctx.reply('❌ Ошибка: '+e.message); }
});

bot.hears('ℹ️ Помощь', ctx=>ctx.reply(HELP_TEXT, mainKeyboard()));

/** ====== SERVER START ====== **/
const app = express();
app.get('/health', (_,res)=>res.send('ok'));
const PORT = process.env.PORT || 3000;

(async ()=>{
  if (WEBHOOK_BASE_URL){
    const path='/tg-webhook';
    app.post(path, express.json(), (req,res)=>bot.webhookCallback(path)(req,res));
    await bot.telegram.setWebhook(`${WEBHOOK_BASE_URL}${path}`);
    app.listen(PORT, ()=>console.log('Bot via webhook on', PORT, 'url:', `${WEBHOOK_BASE_URL}${path}`));
  } else {
    await bot.launch();
    app.listen(PORT, ()=>console.log('Bot via long polling on', PORT));
  }
  process.once('SIGINT', ()=>bot.stop('SIGINT'));
  process.once('SIGTERM', ()=>bot.stop('SIGTERM'));
})();
