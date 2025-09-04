/* ===== Быстрые метрики ===== */
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
        if (st === "К перевыпуску" || st === "Перевыпуск") reissue++; // совместимость со старым значением
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
