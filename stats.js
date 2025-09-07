// stats.js — обработчики «📊 Статистика» (Telegraf) без axios, через встроенный fetch

const STATS_URL   = process.env.CRM2_STATS_URL;   // URL Google Apps Script Web App
const STATS_TOKEN = process.env.CRM2_STATS_TOKEN; // Токен, который проверяешь в doGet(e)

const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;

async function fetchStats() {
  if (!STATS_URL || !STATS_TOKEN) {
    throw new Error('Переменные окружения CRM2_STATS_URL/CRM2_STATS_TOKEN не заданы');
  }

  // Сформируем URL с параметрами ?action=stats&token=...
  const url = new URL(STATS_URL);
  url.searchParams.set('action', 'stats');
  url.searchParams.set('token', STATS_TOKEN);

  const res = await fetch(url, { method: 'GET' });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Ответ не JSON, HTTP ${res.status}`);
  }

  // Ожидаем формат: { ok:true, today, week7, expMon, incMon, netMon }
  if (!res.ok || data?.ok !== true) {
    throw new Error(data?.error || `Ошибка запроса статистики, HTTP ${res.status}`);
  }
  return data;
}

export function attachStatsHandlers(bot) {
  const sendStats = async (ctx) => {
    try {
      const s = await fetchStats();
      await ctx.reply(
        [
          `Расходы за сегодня: ${usd(s.today)}`,
          `Расходы за 7 дней: ${usd(s.week7)}`,
          `Расходы за месяц: ${usd(s.expMon)}`,
          `Доходы за месяц: ${usd(s.incMon)}`,
          `Чистый результат (месяц): ${usd(s.netMon)}`
        ].join('\n')
      );
    } catch (err) {
      console.error('stats error:', err);
      await ctx.reply('Не удалось получить статистику 😕');
    }
  };

  // Команда /stats
  bot.command('stats', sendStats);

  // И нажатие кнопки/сообщение «📊 Статистика»
  bot.hears('📊 Статистика', sendStats);
}
