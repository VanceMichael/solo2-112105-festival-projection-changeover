// 场地当地时间与 UTC 之间的换算。
// 排期给出的是当地墙上时钟（date + HH:mm）和 IANA 时区，结束早于开始表示跨午夜。

const HOUR = 3600_000;

// 取某一 UTC 时刻在指定时区的固定偏移（毫秒）。借助 Intl 读取 longOffset 分量。
function offsetAt(utcInstant, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(utcInstant);
  const get = type => Number(parts.find(p => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second'));
  return asUtc - utcInstant.getTime();
}

// 当地墙上时间 -> UTC Date。先按零偏移拼成 UTC 日期，再减去当时区在该瞬间的偏移。
export function localToUtc(zone, date, hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number);
  const [year, month, day] = date.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  const instant = new Date(wall - offsetAt(new Date(wall), zone));
  // 夏令时跳变时偏移可能在两个候选瞬间不同，再校一次。
  const corrected = new Date(wall - offsetAt(instant, zone));
  return corrected.getTime() === instant.getTime() ? instant : corrected;
}

// 解析排期事件，返回覆盖整场（含跨午夜）的 UTC 起止区间。
export function eventWindow(event) {
  const start = localToUtc(event.zone, event.date, event.fromTime);
  let end = localToUtc(event.zone, event.date, event.toTime);
  if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 24 * HOUR);
  return { start, end };
}

// 授权 UTC 区间（ISO 字符串）是否完整覆盖整场本地换算后的区间。边界相等视为覆盖。
export function coversWindow(license, window) {
  const start = new Date(license.startUtc).getTime();
  const end = new Date(license.endUtc).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start <= window.start.getTime() && end >= window.end.getTime();
}
