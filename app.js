'use strict';

/* ==========================================================================
   КОНФИГ — правила MMR

   Каждый навык — независимый профиль: свой MMR, ранг, серия, история
   пропусков и дневной кап. Гармошка на x2.0 серии не даёт горловому пению
   вообще ничего — они не делят ни очки, ни лимит минут.
   ========================================================================== */

const MMR_PER_MINUTE  = 2.5;
const DAILY_CAP       = 20;       // минут в день на КАЖДЫЙ навык (анти-тильт)
const ABANDON_PENALTY = 100;      // MMR за один пропущенный день одного навыка

// Порог серии -> множитель. Проверяется сверху вниз.
const STREAK_TIERS = [
  { days: 7, mult: 2.0 },
  { days: 3, mult: 1.5 },
];

// Навыки по умолчанию. Дальше пользователь добавляет свои прямо в интерфейсе.
const DEFAULT_SKILLS = [
  { id: 'harmonica', label: 'Губная гармошка', short: 'Гармошка', icon: '🎵' },
  { id: 'throat',    label: 'Горловое пение',  short: 'Горловое', icon: '🗣️' },
];

const MAX_SKILLS = 10;

// Спека давала Стража от 760 — диапазон 751–759 не покрывался ничем.
// Закрыто: Страж начинается с 751.
const RANKS = [
  { ru: 'Рекрут',    en: 'Herald',   min: 0,    max: 750,      stars: true  },
  { ru: 'Страж',     en: 'Guardian', min: 751,  max: 1500,     stars: true  },
  { ru: 'Рыцарь',    en: 'Crusader', min: 1501, max: 2300,     stars: true  },
  { ru: 'Герой',     en: 'Archon',   min: 2301, max: 3100,     stars: true  },
  { ru: 'Легенда',   en: 'Legend',   min: 3101, max: 3900,     stars: true  },
  { ru: 'Властелин', en: 'Ancient',  min: 3901, max: 4700,     stars: true  },
  { ru: 'Дивайн',    en: 'Divine',   min: 4701, max: 5400,     stars: true  },
  { ru: 'ТИТАН',     en: 'Immortal', min: 5401, max: Infinity, stars: false },
];

const STARS_PER_RANK = 5;

// Пороги теплокарты: минут за день (сумма по всем навыкам) -> уровень 0..4
const HEAT_LEVELS = [
  { min: 1,  max: 10,       level: 1, label: '1–10'  },
  { min: 11, max: 20,       level: 2, label: '11–20' },
  { min: 21, max: 30,       level: 3, label: '21–30' },
  { min: 31, max: Infinity, level: 4, label: '31–40' },
];

const STORAGE_KEY  = 'mmr_tracker_v1';
const PERIOD_KEY   = 'mmr_tracker_period';
const LOG_LIMIT    = 250;
const MIN_ALL_DAYS = 84;          // «All» показывает минимум 12 недель

/* ==========================================================================
   ДАТЫ (всё в локальном времени, ISO-строки YYYY-MM-DD)
   ========================================================================== */

const pad = n => String(n).padStart(2, '0');
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function fromISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const todayISO = () => toISO(new Date());

function shiftISO(iso, delta) {
  const d = fromISO(iso);
  d.setDate(d.getDate() + delta);
  return toISO(d);
}

// Разница в днях; Math.round гасит сдвиг перевода часов.
const daysBetween = (a, b) => Math.round((fromISO(b) - fromISO(a)) / 86400000);

/** Понедельник той недели, в которую попадает дата. */
function mondayOf(iso) {
  const shift = (fromISO(iso).getDay() + 6) % 7;   // вс=0 -> 6, пн=1 -> 0
  return shiftISO(iso, -shift);
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн',
                'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

const fmtShort = iso => {
  const d = fromISO(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

const fmtLong = iso => {
  const d = fromISO(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${WEEKDAYS[d.getDay()]}`;
};

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

const days = n => plural(n, 'день', 'дня', 'дней');
const mins = n => plural(n, 'минута', 'минуты', 'минут');

/* ==========================================================================
   СОСТОЯНИЕ

   skills[i]  = { id, label, short, icon, archived?,
                  mmr, streak, bestStreak, startDate, lastPracticeDate, losses }
     — losses: ISO -> true, пропуски ЭТОГО навыка, уже принятые (штраф снят)

   days[ISO]  = { skills: { <skillId>: { raw, counted } }, mmr }
     raw     — сколько реально отзанимался (идёт в «наиграно» и в теплокарту)
     counted — сколько ушло в MMR после капа этого навыка
     mmr     — сумма MMR, заработанного за день по всем навыкам (справочно,
               для тултипа теплокарты; на ранги не влияет)
   ========================================================================== */

function blankSkill(base) {
  return {
    id: base.id,
    label: base.label,
    short: base.short || base.label,
    icon: base.icon,
    ...(base.archived ? { archived: true } : {}),
    mmr: 0,
    streak: 0,
    bestStreak: 0,
    startDate: null,
    lastPracticeDate: null,
    losses: {},
  };
}

function blankState() {
  return {
    version: 3,
    skills: DEFAULT_SKILLS.map(s => blankSkill({ ...s })),
    days: {},
    log: [],
  };
}

/**
 * v1 -> v2: минуты навыков хранились в days[iso] фиксированными ключами.
 * v2 -> v3: MMR/ранг/серия были ОБЩИМИ на аккаунт, теперь свои у каждого
 * навыка. Честно разделить накопленный общий MMR по навыкам невозможно —
 * не сохранялось, кто сколько заработал. История дней и теплокарта остаются
 * как есть, а рейтинг каждого навыка стартует заново с нуля.
 */
function migrate(s) {
  if (s.version >= 3) return s;

  if (s.version < 2) {
    for (const iso of Object.keys(s.days || {})) {
      const day = s.days[iso];
      if (day.skills) continue;
      const skills = {};
      for (const id of ['harmonica', 'throat']) {
        if (day[id]) skills[id] = { raw: day[id].raw | 0, counted: day[id].counted | 0 };
        delete day[id];
      }
      day.skills = skills;
    }
  }

  const prevSkills = Array.isArray(s.skills) && s.skills.length ? s.skills : DEFAULT_SKILLS;
  s.skills = prevSkills.map(sk => blankSkill({
    id: sk.id, label: sk.label, short: sk.short || sk.label, icon: sk.icon,
    archived: sk.archived,
  }));
  delete s.mmr; delete s.streak; delete s.bestStreak;
  delete s.startDate; delete s.lastPracticeDate; delete s.losses;

  s.version = 3;
  return s;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return blankState();
    const parsed = migrate(Object.assign(blankState(), JSON.parse(raw)));
    if (!Array.isArray(parsed.skills) || !parsed.skills.length) {
      parsed.skills = DEFAULT_SKILLS.map(s => blankSkill({ ...s }));
    }
    return parsed;
  } catch (err) {
    return blankState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    // приватный режим / переполнение — продолжаем в памяти
  }
}

let state = loadState();
let lastResult = null;
let period = (() => {
  try { return localStorage.getItem(PERIOD_KEY) || '30d'; } catch (err) { return '30d'; }
})();

const activeSkills = () => state.skills.filter(s => !s.archived);
const skillById = id => state.skills.find(s => s.id === id);

/* ==========================================================================
   РАНГИ И ЗВЁЗДЫ (чистые функции: mmr/streak передаются явно)
   ========================================================================== */

const rankFor = mmr => RANKS.find(r => mmr >= r.min && mmr <= r.max) || RANKS[0];

function nextRank(mmr) {
  const i = RANKS.indexOf(rankFor(mmr));
  return RANKS[i + 1] || null;
}

/**
 * Ранг + звезда (1..5) + готовый тайтл вида «Герой 3» для данного MMR.
 *
 * Каждый ранг делится на 5 равных отрезков. Отсчёт идёт от значения ПЕРЕД
 * началом ранга, поэтому верхние границы звёзд совпадают с таблицей:
 * Страж 1 = 751–900, Рыцарь 1 = 1501–1660, Дивайн 1 = 4701–4840.
 * Рекрут начинается с нуля, поэтому его первая звезда на единицу шире (0–150).
 * У ТИТАНа звёзд нет.
 */
function getRankAndStars(mmr) {
  const rank = rankFor(mmr);

  if (!rank.stars) {
    return {
      rank, star: 0, stars: 0, title: rank.ru,
      starFloor: rank.min, starCeil: Infinity,
      toNextStar: null, nextLabel: null, pct: 100,
    };
  }

  const base = rank.min === 0 ? 0 : rank.min - 1;
  const step = (rank.max - base) / STARS_PER_RANK;
  const star = Math.min(STARS_PER_RANK, Math.max(1, Math.ceil((mmr - base) / step)));

  const starFloor = base + step * (star - 1);
  const starCeil  = base + step * star;
  const after     = nextRank(mmr);

  return {
    rank, star, stars: STARS_PER_RANK,
    title: `${rank.ru} ${star}`,
    starFloor, starCeil,
    toNextStar: starCeil - mmr + 1,
    nextLabel: star < STARS_PER_RANK
      ? `${rank.ru} ${star + 1}`
      : (after ? `${after.ru} 1` : null),
    pct: Math.max(0, Math.min(100, ((mmr - starFloor) / step) * 100)),
  };
}

function multFor(streak) {
  const tier = STREAK_TIERS.find(t => streak >= t.days);
  return tier ? tier.mult : 1;
}

/* ==========================================================================
   ДНИ (общее хранилище минут — используется капом и теплокартой)
   ========================================================================== */

function dayEntry(iso, create) {
  if (!state.days[iso] && create) state.days[iso] = { skills: {}, mmr: 0 };
  const day = state.days[iso];
  if (day && !day.skills) day.skills = {};
  return day;
}

function slotFor(day, skillId) {
  if (!day.skills[skillId]) day.skills[skillId] = { raw: 0, counted: 0 };
  return day.skills[skillId];
}

function sumDay(iso, field) {
  const day = state.days[iso];
  if (!day || !day.skills) return 0;
  return Object.values(day.skills).reduce((sum, slot) => sum + (slot[field] || 0), 0);
}

const rawOn = iso => sumDay(iso, 'raw');   // сумма по ВСЕМ навыкам — для теплокарты

/** Сколько минут этого навыка ещё дадут MMR сегодня (кап всегда свой на навык). */
function remainingToday(skillId) {
  const day = state.days[todayISO()];
  const slot = day && day.skills ? day.skills[skillId] : null;
  return Math.max(0, DAILY_CAP - (slot ? slot.counted : 0));
}

function countedToday(skillId) {
  const day = state.days[todayISO()];
  const slot = day && day.skills ? day.skills[skillId] : null;
  return slot ? slot.counted : 0;
}

/** Суммарно наигранных минут за всё время, по всем навыкам (сырые, до капа). */
const totalMinutes = () =>
  Object.keys(state.days).reduce((sum, iso) => sum + rawOn(iso), 0);

const formatHours = minutes => (minutes / 60).toFixed(1);

/** Дни между стартом ЭТОГО навыка и вчера, где по нему нет ни фарма, ни принятого поражения. */
function unsettledMisses(skillId) {
  const skill = skillById(skillId);
  if (!skill || !skill.startDate) return [];

  const yesterday = shiftISO(todayISO(), -1);
  if (daysBetween(skill.startDate, yesterday) < 0) return [];

  const out = [];
  let cursor = skill.startDate;
  for (let guard = 0; guard < 4000; guard++) {
    if (daysBetween(cursor, yesterday) < 0) break;
    const day = state.days[cursor];
    const practiced = !!(day && day.skills[skillId] && day.skills[skillId].raw > 0);
    if (!practiced && !skill.losses[cursor]) out.push(cursor);
    cursor = shiftISO(cursor, 1);
  }
  return out;
}

function trimLog() {
  if (state.log.length > LOG_LIMIT) state.log.length = LOG_LIMIT;
}

/* ==========================================================================
   ДЕЙСТВИЯ
   ========================================================================== */

function farm(skillId, minutes) {
  const skill = skillById(skillId);
  if (!skill) return null;
  if (unsettledMisses(skillId).length) return null;   // сначала принять поражение по этому навыку

  const today = todayISO();
  const practicedToday = !!(state.days[today] && state.days[today].skills[skillId] &&
                             state.days[today].skills[skillId].raw > 0);
  const isFirstEver = !state.log.some(e => e.type === 'farm' && e.skill === skillId);
  const before = getRankAndStars(skill.mmr);

  if (!practicedToday) {
    if (!skill.startDate) skill.startDate = today;
    skill.streak = skill.lastPracticeDate === shiftISO(today, -1) ? skill.streak + 1 : 1;
    skill.bestStreak = Math.max(skill.bestStreak, skill.streak);
  }

  const day     = dayEntry(today, true);
  const slot    = slotFor(day, skillId);
  const counted = Math.min(minutes, remainingToday(skillId));
  const mult    = multFor(skill.streak);
  const gained  = Math.round(counted * MMR_PER_MINUTE * mult);

  slot.raw     += minutes;
  slot.counted += counted;
  day.mmr      += gained;                 // справочная сумма дня по всем навыкам

  skill.mmr = Math.max(0, skill.mmr + gained);
  skill.lastPracticeDate = today;

  state.log.unshift({
    ts: Date.now(), date: today, type: 'farm',
    skill: skillId, skillLabel: skill.short || skill.label, skillIcon: skill.icon,
    minutes, counted, mult, gained, mmrAfter: skill.mmr,
  });
  trimLog();
  saveState();

  const after = getRankAndStars(skill.mmr);

  return {
    type: 'farm', skillId, skillLabel: skill.label,
    minutes, counted, wasted: minutes - counted,
    mult, gained, streak: skill.streak, isFirstEver,
    mmrAfter: skill.mmr,
    rankUp: after.rank !== before.rank,
    starUp: after.rank === before.rank && after.star > before.star,
    title: after.title,
  };
}

/** Принять N самых старых обнаруженных пропусков ЭТОГО навыка. */
function settleMisses(skillId, count) {
  const skill = skillById(skillId);
  if (!skill) return null;

  const pending = unsettledMisses(skillId);
  const take = pending.slice(0, count);
  if (!take.length) return null;

  for (const iso of take) {
    skill.losses[iso] = true;
    skill.mmr = Math.max(0, skill.mmr - ABANDON_PENALTY);
    state.log.unshift({
      ts: Date.now(), date: iso, type: 'loss',
      skill: skillId, skillLabel: skill.short || skill.label, skillIcon: skill.icon,
      penalty: ABANDON_PENALTY, mmrAfter: skill.mmr,
    });
  }

  skill.streak = 0;
  trimLog();
  saveState();

  return {
    type: 'loss', skillId, skillLabel: skill.label,
    dates: take, total: take.length * ABANDON_PENALTY, declared: false,
  };
}

/**
 * Кнопка «Пропустил день» для конкретного навыка. Если по нему уже
 * обнаружена дыра в календаре — закрывает самую старую (чтобы штраф не
 * снялся дважды). Если дыр нет — оформляет добровольный абандон на сегодня:
 * −100 MMR и серия в ноль.
 */
function declareSkip(skillId) {
  const skill = skillById(skillId);
  if (!skill) return null;
  if (unsettledMisses(skillId).length) return settleMisses(skillId, 1);

  const today = todayISO();
  const practicedToday = !!(state.days[today] && state.days[today].skills[skillId] &&
                             state.days[today].skills[skillId].raw > 0);
  if (!practicedToday) skill.losses[today] = true;

  skill.mmr = Math.max(0, skill.mmr - ABANDON_PENALTY);
  skill.streak = 0;
  state.log.unshift({
    ts: Date.now(), date: today, type: 'loss',
    skill: skillId, skillLabel: skill.short || skill.label, skillIcon: skill.icon,
    penalty: ABANDON_PENALTY, declared: true, mmrAfter: skill.mmr,
  });
  trimLog();
  saveState();

  return {
    type: 'loss', skillId, skillLabel: skill.label,
    dates: [today], total: ABANDON_PENALTY, declared: true,
  };
}

function addSkill(label, icon) {
  const name = String(label || '').trim().slice(0, 28);
  if (!name || activeSkills().length >= MAX_SKILLS) return false;

  const existing = state.skills.find(s => s.label.toLowerCase() === name.toLowerCase());
  if (existing) {                       // был убран раньше — возвращаем со всей статистикой
    delete existing.archived;
    saveState();
    return true;
  }

  state.skills.push(blankSkill({
    id: 'skill_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    label: name,
    short: name,
    icon: String(icon || '').trim().slice(0, 4) || '🎯',
  }));
  saveState();
  return true;
}

/** Навык прячется из активного списка, но его MMR, история и минуты остаются. */
function archiveSkill(id) {
  const skill = skillById(id);
  if (!skill || activeSkills().length <= 1) return false;
  skill.archived = true;
  saveState();
  return true;
}

/* ==========================================================================
   КОММЕНТАРИЙ ТРЕНЕРА
   ========================================================================== */

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function coachFarm(r) {
  const info = getRankAndStars(r.mmrAfter);

  if (r.isFirstEver) return pick([
    'Калибровка начата. Первые три дня подряд решают, увидишь ли ты множитель вообще.',
    'Первый матч в базе. Дальше важен не объём, а то, придёшь ли ты завтра.',
  ]);

  if (r.rankUp) return `Ранг взят: ${r.title}. Пороги дальше шире, фарм тот же — считай сам.`;
  if (r.starUp) return `Звезда закрыта: ${r.title}. Ещё несколько таких — и ранг сменится.`;

  if (r.streak === 7) return 'Семь дней подряд. Множитель x2.0 в деле — это твой потолок эффективности.';
  if (r.streak === 3) return 'Три дня подряд. x1.5 активирован. Это база, а не достижение.';

  if (r.wasted > 0) return pick([
    `Кап по «${r.skillLabel}» выбран, ${r.wasted} ${mins(r.wasted)} сверх лимита ушли в ноль.`,
    `Сверх нормы ${r.wasted} ${mins(r.wasted)}: по очкам пусто, по нагрузке минус. Завтра приходи.`,
  ]);

  if (r.counted === 0) return `Лимит по «${r.skillLabel}» на сегодня закрыт ещё раньше. MMR ноль.`;

  if (r.minutes < 5) return pick([
    `${r.minutes} ${mins(r.minutes)} — это разминка, а не матч. Фарм в пределах погрешности.`,
    'Короткая сессия. Серию держит, рейтинг — почти нет.',
  ]);

  if (r.streak >= 7) return `x2.0 на руках, +${r.gained} MMR за сессию. Один пропуск — и откат к базовому фарму.`;
  if (r.streak >= 3) return `Серия держится, x1.5 работает. До x2.0 ещё ${7 - r.streak} ${days(7 - r.streak)}.`;

  return info.nextLabel
    ? `+${r.gained} MMR. До «${info.nextLabel}» ещё ${info.toNextStar} — на текущем темпе это не один день.`
    : `+${r.gained} MMR. Титан достигнут, дальше только объём.`;
}

function coachLoss(r) {
  const tag = r.skillLabel ? `«${r.skillLabel}»: ` : '';

  if (r.declared) return pick([
    `${tag}пропуск засчитан с твоих слов. −100 MMR, серия в ноль. Честно — и дорого.`,
    `${tag}абандон оформлен вручную. Минус сотня и сброс серии, отыгрывать неделю.`,
  ]);
  if (r.dates.length > 1) {
    return `${tag}слито ${r.dates.length} ${days(r.dates.length)} подряд: −${r.total} MMR и серия в ноль. ` +
           'Отыгрывать это придётся неделями.';
  }
  return pick([
    `${tag}абандон зафиксирован: −100 MMR, серия обнулена.`,
    `${tag}день слит. Минус сотня и сброс серии — арифметика простая, выводы за тобой.`,
  ]);
}

/* ==========================================================================
   РЕНДЕР
   ========================================================================== */

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function starsHTML(info) {
  return Array.from({ length: info.stars }, (_, i) =>
    `<span class="star${i < info.star ? ' on' : ''}" aria-hidden="true">★</span>`).join('');
}

function renderHeader() {
  const played = totalMinutes();
  $('playtime-value').textContent = formatHours(played);
  $('playtime-note').textContent = `${played.toLocaleString('ru-RU')} мин суммарно`;
}

function renderSkills() {
  const host = $('skills');
  host.innerHTML = '';
  const list = activeSkills();

  for (const skill of list) {
    const info    = getRankAndStars(skill.mmr);
    const mult    = multFor(skill.streak);
    const pending = unsettledMisses(skill.id);
    const blocked = pending.length > 0;
    const left    = remainingToday(skill.id);
    const full    = left === 0;

    const el = document.createElement('article');
    el.className = 'skill-card' + (blocked ? ' blocked' : '');
    el.innerHTML = `
      <div class="skill-card-head">
        <div class="skill-id">
          <span class="skill-icon" aria-hidden="true">${esc(skill.icon)}</span>
          <div>
            <div class="skill-name">${esc(skill.label)}</div>
            <div class="skill-rank-line">
              <span class="skill-rank">${esc(info.title)}</span>
              <span class="rank-stars" aria-label="Звезда ${info.star} из ${info.stars}">${starsHTML(info)}</span>
            </div>
          </div>
        </div>
        <div class="skill-head-right">
          <div class="skill-mmr">${skill.mmr.toLocaleString('ru-RU')}<span class="unit">MMR</span></div>
          ${list.length > 1
            ? `<button type="button" class="icon-btn" data-remove="${esc(skill.id)}"
                       title="Убрать навык" aria-label="Убрать навык ${esc(skill.label)}">✕</button>`
            : ''}
        </div>
      </div>

      <div class="progress">
        <div class="progress-meta">
          <span>${info.nextLabel ? `До «${info.nextLabel}»` : 'Максимальный ранг'}</span>
          <span class="progress-delta">${info.nextLabel ? info.toNextStar.toLocaleString('ru-RU') + ' MMR' : '—'}</span>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${info.pct}%"></div></div>
      </div>

      <dl class="stats stats-compact">
        <div class="stat">
          <dt>Серия</dt>
          <dd>${skill.streak} <span class="unit">дн.</span> <span class="chip${mult > 1 ? ' hot' : ''}">x${mult.toFixed(1)}</span></dd>
        </div>
        <div class="stat"><dt>Сегодня</dt><dd>${countedToday(skill.id)}<span class="unit">/${DAILY_CAP} мин</span></dd></div>
        <div class="stat"><dt>Рекорд</dt><dd>${skill.bestStreak} <span class="unit">дн.</span></dd></div>
      </dl>

      ${blocked ? `
        <div class="skill-abandon">
          <p><b>Пропущено ${pending.length} ${days(pending.length)}.</b>
             Штраф −${pending.length * ABANDON_PENALTY} MMR, серия обнулится.</p>
          <p class="note">${pending.slice(0, 8).map(fmtShort).join(' · ')}${
            pending.length > 8 ? ` … и ещё ${pending.length - 8}` : ''}</p>
          <div class="skill-abandon-actions">
            <button type="button" class="danger" data-settle-all="${esc(skill.id)}">
              Принять всё · −${pending.length * ABANDON_PENALTY} MMR</button>
            ${pending.length > 1
              ? `<button type="button" class="ghost" data-settle-one="${esc(skill.id)}">Только 1 день (−100)</button>`
              : ''}
          </div>
        </div>
      ` : `
        <div class="skill-row">
          <input type="number" min="1" max="600" step="1" placeholder="мин"
                 id="in-${esc(skill.id)}" aria-label="Минуты практики: ${esc(skill.label)}">
          <span class="quick">
            <button type="button" data-fill="5">5</button>
            <button type="button" data-fill="10">10</button>
            <button type="button" data-fill="15">15</button>
            <button type="button" data-fill="20">20</button>
          </span>
          <button type="button" class="primary" data-commit="${esc(skill.id)}">Засчитать</button>
        </div>
        <div class="skill-foot">
          <span class="skill-cap${full ? ' full' : ''}">${full ? 'кап на сегодня выбран' : `осталось ${left} мин сегодня`}</span>
          <button type="button" class="link-btn" data-skip="${esc(skill.id)}">Пропустил день · −100 MMR</button>
        </div>
      `}
    `;

    host.appendChild(el);
  }

  $('add-skill-card').hidden = list.length >= MAX_SKILLS;
}

function renderResult() {
  const box = $('result');
  if (!lastResult) { box.hidden = true; return; }

  const rows = $('result-rows');
  rows.innerHTML = '';
  box.hidden = false;

  const row = (label, value, cls) => {
    const div = document.createElement('div');
    div.innerHTML = `<dt>${esc(label)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(value)}</dd>`;
    rows.appendChild(div);
  };

  if (lastResult.type === 'loss') {
    const r = lastResult;
    row('Дисциплина', r.skillLabel);
    row('Событие', r.declared ? 'Пропуск заявлен вручную' : 'Обнаружен пропуск');
    row('Дней', String(r.dates.length));
    row('Даты', r.dates.map(fmtShort).join(', '));
    row('Штраф', `−${r.total} MMR`, 'loss');
    row('Серия побед', 'сброшена в 0', 'loss');
    $('coach-text').textContent = coachLoss(r);
  } else {
    const r = lastResult;
    row('Дисциплина', r.skillLabel);
    row('Потрачено времени', `${r.minutes} мин.`);
    if (r.wasted > 0) row('Сверх капа (не в зачёт)', `${r.wasted} мин.`, 'wasted');
    row('Множитель серии', 'x' + r.mult.toFixed(1));
    row('Получено MMR', (r.gained > 0 ? '+' : '') + r.gained, r.gained > 0 ? 'gain' : 'wasted');
    $('coach-text').textContent = coachFarm(r);
  }
}

/* ---------- теплокарта активности (общая, по сумме всех навыков) ---------- */

function heatLevel(minutes) {
  if (minutes <= 0) return 0;
  const band = HEAT_LEVELS.find(b => minutes >= b.min && minutes <= b.max);
  return band ? band.level : 4;
}

function heatRange() {
  const today = todayISO();
  if (period === '7d')  return { from: shiftISO(today, -6),  to: today };
  if (period === '30d') return { from: shiftISO(today, -29), to: today };

  const earliest = shiftISO(today, -(MIN_ALL_DAYS - 1));
  const starts = state.skills.map(s => s.startDate).filter(Boolean);
  const earliestStart = starts.length ? starts.reduce((a, b) => (daysBetween(a, b) < 0 ? a : b)) : null;
  const from = earliestStart && daysBetween(earliestStart, earliest) > 0 ? earliestStart : earliest;
  return { from, to: today };
}

function renderHeatmap() {
  const grid   = $('heat-grid');
  const months = $('heat-months');
  grid.innerHTML = '';
  months.innerHTML = '';

  const { from, to } = heatRange();
  const today = todayISO();
  const firstMonday = mondayOf(from);
  const weeks = Math.floor(daysBetween(firstMonday, to) / 7) + 1;

  let lastMonth = -1;
  let lastLabelWeek = -99;

  for (let w = 0; w < weeks; w++) {
    const weekStart = shiftISO(firstMonday, w * 7);

    // Подпись месяца ставим при смене месяца, но не ближе трёх колонок к
    // предыдущей: название шире клетки и иначе налезает на соседнее.
    const label = document.createElement('span');
    const month = fromISO(weekStart).getMonth();
    if (month !== lastMonth) {
      if (w - lastLabelWeek >= 3) {
        label.textContent = MONTHS[month];
        lastLabelWeek = w;
      }
      lastMonth = month;
    }
    months.appendChild(label);

    for (let d = 0; d < 7; d++) {
      const iso = shiftISO(weekStart, d);
      const inRange = daysBetween(from, iso) >= 0 && daysBetween(iso, to) >= 0;

      if (!inRange) {
        const blank = document.createElement('span');
        blank.className = 'heat-cell blank';
        grid.appendChild(blank);
        continue;
      }

      const raw = rawOn(iso);
      const day = state.days[iso];

      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'heat-cell';
      if (iso === today) cell.classList.add('today');

      const breakdown = [];
      if (day && day.skills) {
        for (const [id, slot] of Object.entries(day.skills)) {
          if (!slot.raw) continue;
          const skill = skillById(id);
          breakdown.push(`${skill ? skill.icon + ' ' + skill.label : id}: ${slot.raw} мин`);
        }
      }

      const missedSkills = state.skills.filter(s => s.losses && s.losses[iso]);

      let lines;
      if (missedSkills.length) {
        cell.classList.add('miss');
        cell.textContent = '✕';
        lines = missedSkills.map(s => `${s.icon} ${s.label}: пропуск · −${ABANDON_PENALTY} MMR`);
      } else if (state.skills.some(s => unsettledMisses(s.id).includes(iso))) {
        cell.classList.add('pending');
        lines = ['Пропуск, поражение не принято'];
      } else {
        cell.classList.add('h' + heatLevel(raw));
        lines = raw
          ? [`Всего: ${raw} мин`, ...breakdown, `MMR за день (все навыки): +${day.mmr}`]
          : [iso === today ? 'Сегодня — фарма ещё нет' : 'Нет активности'];
      }

      cell.setAttribute('aria-label', `${fmtLong(iso)}. ${lines.join('. ')}`);
      attachTip(cell, { title: fmtLong(iso), lines });
      grid.appendChild(cell);
    }
  }

  for (const btn of $('heat-periods').querySelectorAll('[data-period]')) {
    const on = btn.dataset.period === period;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

/* ---------- тултип ---------- */

const tooltip = $('tooltip');

function attachTip(el, tip) {
  const place = () => {
    const r = el.getBoundingClientRect();
    const t = tooltip.getBoundingClientRect();
    let x = r.left + r.width / 2 - t.width / 2;
    let y = r.top - t.height - 8;
    x = Math.max(8, Math.min(x, window.innerWidth - t.width - 8));
    if (y < 8) y = r.bottom + 8;
    tooltip.style.left = x + 'px';
    tooltip.style.top  = y + 'px';
  };
  const show = () => {
    tooltip.innerHTML = `<b>${esc(tip.title)}</b><span>${tip.lines.map(esc).join('<br>')}</span>`;
    tooltip.hidden = false;
    place();
  };
  const hide = () => { tooltip.hidden = true; };

  el.addEventListener('mouseenter', show);
  el.addEventListener('focus', show);
  el.addEventListener('mouseleave', hide);
  el.addEventListener('blur', hide);
}

/* ---------- журнал ---------- */

function renderLog() {
  const body = $('log-body');
  body.innerHTML = '';
  $('log-empty').hidden = state.log.length > 0;

  for (const e of state.log.slice(0, 40)) {
    const tr = document.createElement('tr');
    const icon = e.skillIcon || '🎯';
    const name = e.skillLabel || e.skill || '';

    if (e.type === 'loss') {
      tr.innerHTML = `
        <td>${fmtShort(e.date)}</td>
        <td class="loss">${esc(icon)} ${esc(name)} · Abandon${e.declared ? ' (вручную)' : ''}</td>
        <td class="num">—</td>
        <td class="num loss">−${e.penalty}</td>
        <td class="num total">${e.mmrAfter}</td>`;
    } else {
      const label = `${icon} ${name}` + (e.mult > 1 ? ` · x${e.mult.toFixed(1)}` : '');
      const minutes = e.counted < e.minutes ? `${e.counted}/${e.minutes}` : String(e.minutes);
      tr.innerHTML = `
        <td>${fmtShort(e.date)}</td>
        <td>${esc(label)}</td>
        <td class="num">${minutes}</td>
        <td class="num${e.gained > 0 ? ' gain' : ''}">${e.gained > 0 ? '+' : ''}${e.gained}</td>
        <td class="num total">${e.mmrAfter}</td>`;
    }
    body.appendChild(tr);
  }
}

function render() {
  renderHeader();
  renderSkills();
  renderResult();
  renderHeatmap();
  renderLog();
}

/* ==========================================================================
   СОБЫТИЯ (делегированы на #skills — карточки перерисовываются целиком)
   ========================================================================== */

function commit(skillId, input) {
  const minutes = Math.floor(Number(input.value));
  if (!Number.isFinite(minutes) || minutes < 1) { input.focus(); return; }

  const result = farm(skillId, Math.min(minutes, 600));
  if (!result) return;
  lastResult = result;
  render();
  $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('skills').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.dataset.fill) {
    const input = btn.closest('.skill-row').querySelector('input[type="number"]');
    input.value = btn.dataset.fill;
    input.focus();
    return;
  }
  if (btn.dataset.commit) { commit(btn.dataset.commit, $('in-' + btn.dataset.commit)); return; }

  if (btn.dataset.remove) {
    const skill = skillById(btn.dataset.remove);
    if (skill && confirm(`Убрать «${skill.label}» из списка? MMR, ранг и история останутся — просто скроется форма ввода.`)) {
      archiveSkill(btn.dataset.remove);
      render();
    }
    return;
  }

  if (btn.dataset.settleAll) {
    const skillId = btn.dataset.settleAll;
    const skill = skillById(skillId);
    const n = unsettledMisses(skillId).length;
    if (n && confirm(`Принять поражение по «${skill.label}» за ${n} ${days(n)}? Списывается ${n * ABANDON_PENALTY} MMR, серия обнулится.`)) {
      lastResult = settleMisses(skillId, n);
      render();
    }
    return;
  }

  if (btn.dataset.settleOne) {
    lastResult = settleMisses(btn.dataset.settleOne, 1);
    render();
    return;
  }

  if (btn.dataset.skip) {
    const skillId = btn.dataset.skip;
    const skill = skillById(skillId);
    const question = unsettledMisses(skillId).length
      ? `Закрыть самый старый пропуск по «${skill.label}»? −${ABANDON_PENALTY} MMR, серия обнулится.`
      : `Отметить пропуск по «${skill.label}» сегодня? −${ABANDON_PENALTY} MMR, серия обнулится. Отменить нельзя.`;
    if (confirm(question)) {
      lastResult = declareSkip(skillId);
      render();
      $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
});

$('skills').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest('input[type="number"]');
  if (!input) return;
  commit(input.id.replace(/^in-/, ''), input);
});

$('form-skill').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('new-skill-name');
  const icon = $('new-skill-icon');
  if (!addSkill(name.value, icon.value)) { name.focus(); return; }
  name.value = '';
  icon.value = '';
  render();
});

$('heat-periods').addEventListener('click', e => {
  const btn = e.target.closest('[data-period]');
  if (!btn) return;
  period = btn.dataset.period;
  try { localStorage.setItem(PERIOD_KEY, period); } catch (err) { /* не критично */ }
  renderHeatmap();
});

$('btn-reset').addEventListener('click', () => {
  if (!confirm('Сбросить весь прогресс? MMR, ранги, серии, навыки и история будут стёрты без возможности восстановления.')) return;
  state = blankState();
  lastResult = null;
  saveState();
  render();
});

// Перерисовать, если вкладка провисела открытой через полночь.
let renderedOn = todayISO();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && todayISO() !== renderedOn) {
    renderedOn = todayISO();
    lastResult = null;
    render();
  }
});

render();
