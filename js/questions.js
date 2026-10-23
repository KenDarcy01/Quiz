// Loads questions from a Google Sheet (or the bundled copy) and picks them by age, grade and topic.

// The family question sheet, used when no other link is set in Settings.
const DEFAULT_SHEET_URL = '';
const BUNDLED_URL = 'questions/questions.csv';
const CACHE_KEY = 'fq.questions.v2';
const ADULT_AGE = 18;

// Accepts a normal share link, a "Publish to web" CSV link, or any CSV URL.
function sheetCsvUrl(url) {
  const trimmed = (url || '').trim();
  if (!trimmed) return '';
  if (/output=csv|tqx=out:csv/.test(trimmed)) return trimmed;
  const m = trimmed.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m && m[1] !== 'e') {
    const gid = (trimmed.match(/[#&?]gid=(\d+)/) || [])[1];
    return `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:csv${gid ? `&gid=${gid}` : ''}`;
  }
  return trimmed;
}

// "adult", "10", "6-7", "16+" or blank (any age) → { min, max }.
function parseAgeRange(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v || v === 'all' || v === 'any') return { min: 0, max: 999 };
  if (v.startsWith('adult')) return { min: ADULT_AGE, max: 999 };
  const range = v.match(/^(\d+)\s*[-–to]+\s*(\d+)$/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const plus = v.match(/^(\d+)\s*\+$/);
  if (plus) return { min: Number(plus[1]), max: 999 };
  const n = Number(v.replace(/[^0-9]/g, ''));
  return Number.isFinite(n) && n > 0 ? { min: n, max: n } : { min: 0, max: 999 };
}

// A player's age setting ("6"–"17" or "adult") as a number.
function playerAge(age) {
  return String(age).toLowerCase() === 'adult' ? ADULT_AGE : Number(age) || ADULT_AGE;
}

function hashId(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function rowsToQuestions(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const idx = {
    topic: col('topic', 'category', 'round name'),
    age: col('age', 'ages', 'age band'),
    grade: col('grade', 'difficulty'),
    question: col('question'),
    answer: col('answer'),
    wrong: ['wrong1', 'wrong2', 'wrong3'].map((n) => col(n)),
  };
  if (idx.question < 0 || idx.answer < 0) {
    throw new Error('The sheet needs columns named question and answer.');
  }
  const cell = (r, i) => (i >= 0 ? (r[i] || '').trim() : '');
  return rows.slice(1).map((r) => {
    const question = cell(r, idx.question);
    const answer = cell(r, idx.answer);
    const ageText = cell(r, idx.age);
    const grade = Math.min(5, Math.max(1, Number(cell(r, idx.grade)) || 3));
    return {
      id: hashId(`${question}|${answer}|${ageText}`),
      topic: cell(r, idx.topic) || 'General knowledge',
      ageText,
      age: parseAgeRange(ageText),
      grade,
      question,
      answer,
      wrong: idx.wrong.map((w) => cell(r, w)).filter(Boolean),
    };
  }).filter((q) => q.question && q.answer);
}

async function fetchCsv(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`The sheet could not be loaded (error ${res.status}).`);
  const text = await res.text();
  if (/^\s*</.test(text)) throw new Error('The sheet is not shared publicly. Set sharing to "Anyone with the link can view".');
  return rowsToQuestions(parseCSV(text));
}

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; }
}
function writeCache(entry) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(entry)); } catch { /* storage full or blocked */ }
}

// Returns { questions, source: 'sheet' | 'cache' | 'bundled', error }.
async function loadQuestions(sheetUrl) {
  const url = sheetCsvUrl(sheetUrl);
  let error = null;
  if (url) {
    try {
      const questions = await fetchCsv(url);
      if (!questions.length) throw new Error('The sheet has no questions yet.');
      writeCache({ url, questions, at: Date.now() });
      return { questions, source: 'sheet', error };
    } catch (e) {
      error = e.message || String(e);
      const cached = readCache();
      if (cached && cached.url === url) return { questions: cached.questions, source: 'cache', error };
    }
  }
  const questions = await fetchCsv(BUNDLED_URL);
  return { questions, source: 'bundled', error };
}

function topicsIn(questions) {
  return [...new Set(questions.map((q) => q.topic))].sort((a, b) => a.localeCompare(b));
}

// Questions that suit a player of this age, in the chosen topic and grade range.
function poolFor(questions, age, topic, grades) {
  const years = playerAge(age);
  return questions.filter((q) => years >= q.age.min && years <= q.age.max
    && (!topic || q.topic === topic)
    && grades.includes(q.grade));
}
