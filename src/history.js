// Historical notes and anniversaries are not news (owner, 30.10: «30 октября 1961 года СССР испытал Царь-бомбу… для чего она? не связана с реальностью» — "On 30 October 1961 the USSR tested the Tsar Bomba… what for? not connected with reality").
// The event headline is checked for: «65 лет назад» ("65 years ago"), «в этот день» ("on this day"), «годовщина» ("anniversary"), «исполнилось 80 лет» ("turned 80"), «в 1961 году …» ("in 1961 …").
// JS \b does not know Cyrillic — word boundaries are set via \p{L}.
const norm = (s) => ` ${String(s ?? '').toLowerCase().replace(/ё/g, 'е')} `;
const B = String.raw`(?<![\p{L}\d])`;
const E = String.raw`(?![\p{L}\d])`;
const rx = (src) => new RegExp(`${B}(?:${src})${E}`, 'u');

const RULES = [
  [rx(String.raw`\d{1,3}\s+(?:лет|год|года)\s+назад`), 'N лет назад'],
  [rx(String.raw`в\s+этот\s+день|сегодня\s+в\s+истории|день\s+в\s+истории|on\s+this\s+day`), 'в этот день'],
  [rx(String.raw`годовщин[аыуе]`), 'годовщина'],
  [rx(String.raw`исполнил(?:ось|ся|ась)\s+\d{1,3}\s+(?:лет|год|года)`), 'исполнилось N лет'],
  [rx(String.raw`\d{1,3}\s*-?\s*лети[ея]`), 'N-летие'],
  [rx(String.raw`в\s+(?:1[0-9]{3}|19[0-9]{2}|200[0-9]|201[0-5])\s+году`), 'в давнем году'],
];

/** Причина, по которой заголовок — историческая справка, или null. */
export function historicalReason(title) {
  const t = norm(title);
  for (const [r, why] of RULES) if (r.test(t)) return why;
  return null;
}
