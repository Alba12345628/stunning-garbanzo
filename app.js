'use strict';

/* ==========================================================================
   КОНФИГ — правила MMR
   ========================================================================== */

const MMR_PER_MINUTE  = 2.5;
const DAILY_CAP       = 20;       // минут в день, дающих MMR (анти-тильт)
const ABANDON_PENALTY = 100;      // MMR за один пропущенный день

// Как считается кап:
//   'total'     — 20 минут в день на все дисциплины вместе (так написано в спеке)
//   'per_skill' — 20 минут в день на КАЖДУЮ дисциплину отдельно
const CAP_MODE = 'total';

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

// Пороги теплокарты: минут за день -> уровень заливки 0..4
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

   days[ISO] = { skills: { <skillId>: { raw, counted } }, mmr }
     raw     — сколько реально отзанимался (идёт в «наиграно» и в теплокарту)
     counted — сколько ушло в MMR после капа
   ========================================================================== */

function blankState() {
  return {
    version: 2,
    startDate: null,        // день первого зачтённого фарма
    mmr: 0,
    streak: 0,
    bestStreak: 0,
    lastPracticeDate: null,
    skills: DEFAULT_SKILLS.map(s => ({ ...s })),
    days: {},
    losses: {},             // ISO -> true (пропуск, штраф уже снят)
    log: [],
  };
}

/** Состояние v1 хранило навыки фиксированными ключами дня. Переводим в v2. */
function migrate(s) {
  if (s.version >= 2) return s;

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

  s.skills = DEFAULT_SKILLS.map(x => ({ ...x }));
  s.version = 2;
  return s;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return blankState();
    const parsed = migrate(Object.assign(blankState(), JSON.parse(raw)));
    if (!Array.isArray(parsed.skills) || !parsed.skills.length) {
      parsed.skills = DEFAULT_SKILLS.map(s => ({ ...s }));
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
   РАНГИ И ЗВЁЗДЫ
   ========================================================================== */

const rankFor = mmr => RANKS.find(r => mmr >= r.min && mmr <= r.max) || RANKS[0];

function nextRank(mmr) {
  const i = RANKS.indexOf(rankFor(mmr));
  return RANKS[i + 1] || null;
}

/**
 * Текущий ранг + звезда (1..5) + готовый тайтл вида «Герой 3».
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
   ДНИ, КАП, ПРОПУСКИ
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

const rawOn     = iso => sumDay(iso, 'raw');
const countedOn = iso => sumDay(iso, 'counted');

function remainingToday(skillId) {
  const today = todayISO();
  if (CAP_MODE === 'per_skill') {
    const day = state.days[today];
    const slot = day && day.skills ? day.skills[skillId] : null;
    return Math.max(0, DAILY_CAP - (slot ? slot.counted : 0));
  }
  return Math.max(0, DAILY_CAP - countedOn(today));
}

/** Суммарно наигранных минут за всё время (сырые минуты, до капа). */
const totalMinutes = () =>
  Object.keys(state.days).reduce((sum, iso) => sum + rawOn(iso), 0);

const formatHours = minutes => (minutes / 60).toFixed(1);

/** Дни между стартом и вчера, за которые нет ни фарма, ни принятого поражения. */
function unsettledMisses() {
  if (!state.startDate) return [];
  const yesterday = shiftISO(todayISO(), -1);
  if (daysBetween(state.startDate, yesterday) < 0) return [];

  const out = [];
  let cursor = state.startDate;
  for (let guard = 0; guard < 4000; guard++) {
    if (daysBetween(cursor, yesterday) < 0) break;
    if (!state.days[cursor] && !state.losses[cursor]) out.push(cursor);
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
  if (unsettledMisses().length) return null;   // сначала принять поражение

  const skill = skillById(skillId);
  if (!skill) return null;

  const today = todayISO();
  const firstSessionToday = !state.days[today];
  const isFirstEver = state.log.length === 0;
  const before = getRankAndStars(state.mmr);

  if (firstSessionToday) {
    if (!state.startDate) state.startDate = today;
    state.streak = state.lastPracticeDate === shiftISO(today, -1) ? state.streak + 1 : 1;
    state.bestStreak = Math.max(state.bestStreak, state.streak);
  }

  const day     = dayEntry(today, true);
  const slot    = slotFor(day, skillId);
  const counted = Math.min(minutes, remainingToday(skillId));
  const mult    = multFor(state.streak);
  const gained  = Math.round(counted * MMR_PER_MINUTE * mult);

  slot.raw     += minutes;
  slot.counted += counted;
  day.mmr      += gained;

  state.mmr = Math.max(0, state.mmr + gained);
  state.lastPracticeDate = today;

  state.log.unshift({
    ts: Date.now(), date: today, type: 'farm',
    skill: skillId, skillLabel: skill.short || skill.label, skillIcon: skill.icon,
    minutes, counted, mult, gained, mmrAfter: state.mmr,
  });
  trimLog();
  saveState();

  const after = getRankAndStars(state.mmr);

  return {
    type: 'farm', skillId, skillLabel: skill.label,
    minutes, counted, wasted: minutes - counted,
    mult, gained, streak: state.streak, isFirstEver,
    rankUp: after.rank !== before.rank,
    starUp: after.rank === before.rank && after.star > before.star,
    title: after.title,
  };
}

/** Принять N самых старых обнаруженных пропусков. */
function settleMisses(count) {
  const pending = unsettledMisses();
  const take = pending.slice(0, count);
  if (!take.length) return null;

  for (const iso of take) {
    state.losses[iso] = true;
    state.mmr = Math.max(0, state.mmr - ABANDON_PENALTY);
    state.log.unshift({
      ts: Date.now(), date: iso, type: 'loss',
      penalty: ABANDON_PENALTY, mmrAfter: state.mmr,
    });
  }

  state.streak = 0;
  trimLog();
  saveState();

  return { type: 'loss', dates: take, total: take.length * ABANDON_PENALTY, declared: false };
}

/**
 * Кнопка «Пропустил день». Если приложение уже обнаружило дыру в календаре —
 * закрывает самую старую из них, чтобы штраф не снялся дважды. Если дыр нет —
 * оформляет добровольный абандон по спеке: −100 MMR и серия в ноль.
 */
function declareSkip() {
  if (unsettledMisses().length) return settleMisses(1);

  const today = todayISO();
  if (!state.days[today]) state.losses[today] = true;

  state.mmr = Math.max(0, state.mmr - ABANDON_PENALTY);
  state.streak = 0;
  state.log.unshift({
    ts: Date.now(), date: today, type: 'loss',
    penalty: ABANDON_PENALTY, declared: true, mmrAfter: state.mmr,
  });
  trimLog();
  saveState();

  return { type: 'loss', dates: [today], total: ABANDON_PENALTY, declared: true };
}

function addSkill(label, icon) {
  const name = String(label || '').trim().slice(0, 28);
  if (!name || activeSkills().length >= MAX_SKILLS) return false;

  const existing = state.skills.find(s => s.label.toLowerCase() === name.toLowerCase());
  if (existing) {                       // был убран раньше — просто возвращаем
    delete existing.archived;
    saveState();
    return true;
  }

  state.skills.push({
    id: 'skill_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    label: name,
    short: name,
    icon: String(icon || '').trim().slice(0, 4) || '🎯',
  });
  saveState();
  return true;
}

/** Навык прячется из формы, но его минуты остаются в истории и на теплокарте. */
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
  const info = getRankAndStars(state.mmr);

  if (r.isFirstEver) return pick([
    'Калибровка начата. Первые три дня подряд решают, увидишь ли ты множитель вообще.',
    'Первый матч в базе. Дальше важен не объём, а то, придёшь ли ты завтра.',
  ]);

  if (r.rankUp) return `Ранг взят: ${r.title}. Пороги дальше шире, фарм тот же — считай сам.`;
  if (r.starUp) return `Звезда закрыта: ${r.title}. Ещё несколько таких — и ранг сменится.`;

  if (r.streak === 7) return 'Семь дней подряд. Множитель x2.0 в деле — это твой потолок эффективности.';
  if (r.streak === 3) return 'Три дня подряд. x1.5 активирован. Это база, а не достижение.';

  if (r.wasted > 0) return pick([
    `Кап выбран, ${r.wasted} ${mins(r.wasted)} сверх лимита ушли в ноль. Связки не резина.`,
    `Сверх нормы ${r.wasted} ${mins(r.wasted)}: по очкам пусто, по нагрузке минус. Завтра приходи.`,
  ]);

  if (r.counted === 0) return 'Лимит на сегодня закрыт ещё раньше. Этот фарм MMR не принёс.';

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
  if (r.declared) return pick([
    'Пропуск засчитан с твоих слов: −100 MMR, серия в ноль. Честно — и дорого.',
    'Абандон оформлен вручную. Минус сотня и сброс серии, отыгрывать неделю.',
  ]);
  if (r.dates.length > 1) {
    return `Слито ${r.dates.length} ${days(r.dates.length)} подряд: −${r.total} MMR и серия в ноль. ` +
           'Отыгрывать это придётся неделями.';
  }
  return pick([
    'Абандон зафиксирован: −100 MMR, серия обнулена. Пропуск стоит дороже, чем 20 минут практики.',
    'День слит. Минус сотня и сброс серии — арифметика простая, выводы за тобой.',
  ]);
}

/* ==========================================================================
   РЕНДЕР
   ========================================================================== */

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderProfile() {
  const info = getRankAndStars(state.mmr);
  const after = nextRank(state.mmr);

  $('mmr-value').textContent = state.mmr.toLocaleString('ru-RU');
  $('rank-ru').textContent = info.title;
  $('rank-en').textContent = info.rank.en;

  const starsBox = $('rank-stars');
  if (info.stars) {
    starsBox.hidden = false;
    starsBox.innerHTML = Array.from({ length: info.stars }, (_, i) =>
      `<span class="star${i < info.star ? ' on' : ''}" aria-hidden="true">★</span>`).join('');
    starsBox.setAttribute('aria-label', `Звезда ${info.star} из ${info.stars}`);
  } else {
    starsBox.hidden = true;
  }

  const played = totalMinutes();
  $('playtime-value').textContent = formatHours(played);
  $('playtime-note').textContent = `${played.toLocaleString('ru-RU')} мин за всё время`;

  $('progress-fill').style.width = info.pct + '%';
  $('progress-bar').setAttribute('aria-valuenow', Math.round(info.pct));

  if (info.nextLabel) {
    $('progress-label').textContent = `До «${info.nextLabel}»`;
    $('progress-delta').textContent = `${info.toNextStar.toLocaleString('ru-RU')} MMR`;
  } else {
    $('progress-label').textContent = 'Максимальный ранг';
    $('progress-delta').textContent = '—';
  }

  $('rank-note').textContent = after
    ? `До ранга «${after.ru}»: ${(after.min - state.mmr).toLocaleString('ru-RU')} MMR`
    : 'Выше рангов нет';

  const mult = multFor(state.streak);
  $('streak-value').textContent = state.streak;
  $('streak-unit').textContent  = days(state.streak);
  const chip = $('streak-mult');
  chip.textContent = 'x' + mult.toFixed(1);
  chip.classList.toggle('hot', mult > 1);

  $('today-value').textContent = countedOn(todayISO());
  $('today-cap').textContent =
    `/${CAP_MODE === 'total' ? DAILY_CAP : DAILY_CAP * activeSkills().length} мин`;
  $('best-value').textContent = state.bestStreak;
}

function renderAbandon() {
  const pending = unsettledMisses();
  const box = $('abandon');

  if (!pending.length) {
    box.hidden = true;
    return false;
  }

  const n = pending.length;
  box.hidden = false;
  $('abandon-text').textContent =
    `Пропущено ${n} ${days(n)}. Штраф −${n * ABANDON_PENALTY} MMR, серия обнуляется.`;

  const shown = pending.slice(0, 12).map(fmtShort).join(' · ');
  $('abandon-dates').textContent =
    pending.length > 12 ? `${shown} … и ещё ${pending.length - 12}` : shown;

  $('btn-settle-all').textContent = `Принять всё · −${n * ABANDON_PENALTY} MMR`;
  $('btn-settle-one').hidden = n < 2;
  return true;
}

function renderSkills(blocked) {
  const host = $('skills');
  host.innerHTML = '';
  const list = activeSkills();

  for (const skill of list) {
    const left = remainingToday(skill.id);
    const full = left === 0;

    const el = document.createElement('div');
    el.className = 'skill';
    el.innerHTML = `
      <div class="skill-head">
        <span class="skill-name"><span aria-hidden="true">${esc(skill.icon)}</span> ${esc(skill.label)}</span>
        <span class="skill-meta">
          <span class="skill-cap${full ? ' full' : ''}">${full ? 'кап выбран' : `осталось ${left} мин`}</span>
          ${list.length > 1
            ? `<button type="button" class="icon-btn" data-remove="${esc(skill.id)}"
                       title="Убрать навык" aria-label="Убрать навык ${esc(skill.label)}">✕</button>`
            : ''}
        </span>
      </div>
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
      </div>`;

    const input = el.querySelector('input');
    el.querySelectorAll('[data-fill]').forEach(btn => {
      btn.addEventListener('click', () => { input.value = btn.dataset.fill; input.focus(); });
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') commit(skill.id, input); });
    el.querySelector('[data-commit]').addEventListener('click', () => commit(skill.id, input));

    const remove = el.querySelector('[data-remove]');
    if (remove) remove.addEventListener('click', () => {
      if (!confirm(`Убрать «${skill.label}» из списка? Наигранные минуты останутся в истории и на графике.`)) return;
      archiveSkill(skill.id);
      render();
    });

    if (blocked) el.querySelectorAll('input, [data-fill], [data-commit]')
      .forEach(node => { node.disabled = true; });

    host.appendChild(el);
  }

  $('add-skill').hidden = list.length >= MAX_SKILLS;
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

/* ---------- теплокарта активности ---------- */

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
  const from = state.startDate && daysBetween(state.startDate, earliest) > 0
    ? state.startDate
    : earliest;
  return { from, to: today };
}

function renderHeatmap() {
  const grid   = $('heat-grid');
  const months = $('heat-months');
  grid.innerHTML = '';
  months.innerHTML = '';

  const { from, to } = heatRange();
  const today = todayISO();
  const pending = new Set(unsettledMisses());
  const firstMonday = mondayOf(from);
  const weeks = Math.floor(daysBetween(firstMonday, to) / 7) + 1;

  let lastMonth = -1;
  let lastLabelWeek = -99;

  for (let w = 0; w < weeks; w++) {
    const weekStart = shiftISO(firstMonday, w * 7);

    // подпись месяца над той колонкой, где месяц сменился
    // Подпись ставим при смене месяца, но не ближе трёх колонок к предыдущей:
    // название шире клетки и иначе налезает на соседнее.
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

      let lines;
      if (state.losses[iso]) {
        cell.classList.add('miss');
        cell.textContent = '✕';
        lines = [`Пропуск · −${ABANDON_PENALTY} MMR`];
      } else if (pending.has(iso)) {
        cell.classList.add('pending');
        lines = ['Пропуск, поражение не принято'];
      } else {
        cell.classList.add('h' + heatLevel(raw));
        lines = raw
          ? [`Всего: ${raw} мин`, ...breakdown, `MMR за день: +${day.mmr}`]
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

    if (e.type === 'loss') {
      tr.innerHTML = `
        <td>${fmtShort(e.date)}</td>
        <td class="loss">Abandon${e.declared ? ' (вручную)' : ''}</td>
        <td class="num">—</td>
        <td class="num loss">−${e.penalty}</td>
        <td class="num total">${e.mmrAfter}</td>`;
    } else {
      const label = `${e.skillIcon || '🎯'} ${e.skillLabel || e.skill}` +
                    (e.mult > 1 ? ` · x${e.mult.toFixed(1)}` : '');
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
  const blocked = renderAbandon();
  renderProfile();
  renderSkills(blocked);
  renderResult();
  renderHeatmap();
  renderLog();
}

/* ==========================================================================
   СОБЫТИЯ
   ========================================================================== */

function commit(skillId, input) {
  const minutes = Math.floor(Number(input.value));
  if (!Number.isFinite(minutes) || minutes < 1) { input.focus(); return; }

  const result = farm(skillId, Math.min(minutes, 600));
  if (!result) return;
  lastResult = result;
  input.value = '';
  render();
  $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('btn-settle-all').addEventListener('click', () => {
  const n = unsettledMisses().length;
  if (!n) return;
  if (!confirm(`Принять поражение за ${n} ${days(n)}? Списывается ${n * ABANDON_PENALTY} MMR, серия обнуляется.`)) return;
  lastResult = settleMisses(n);
  render();
});

$('btn-settle-one').addEventListener('click', () => {
  lastResult = settleMisses(1);
  render();
});

$('btn-skip').addEventListener('click', () => {
  const question = unsettledMisses().length
    ? `Закрыть самый старый обнаруженный пропуск? −${ABANDON_PENALTY} MMR, серия обнуляется.`
    : `Отметить пропущенный день? −${ABANDON_PENALTY} MMR, серия обнуляется. Отменить нельзя.`;
  if (!confirm(question)) return;
  lastResult = declareSkip();
  render();
  $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
  if (!confirm('Сбросить весь прогресс? MMR, ранг, серия, навыки и история будут стёрты без возможности восстановления.')) return;
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
