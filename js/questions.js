// Loads questions from a Google Sheet (or the bundled sample) and groups them by round and age.

const SAMPLE_URL = 'questions/sample.csv';
const CACHE_KEY = 'fq.questions.v1';
const AGE_GROUPS = ['10', '13', '14', 'adult'];

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

function normaliseAge(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v.startsWith('adult')) return 'adult';
  const n = v.replace(/[^0-9]/g, '');
  return AGE_GROUPS.includes(n) ? n : v;
}

function rowsToQuestions(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const idx = {
    round: col('round'), age: col('age'), number: col('number'),
    question: col('question'), answer: col('answer'),
    wrong: ['wrong1', 'wrong2', 'wrong3'].map(col),
  };
  if (idx.question < 0 || idx.answer < 0 || idx.age < 0) {
    throw new Error('The sheet needs columns named round, age, question and answer.');
  }
  return rows.slice(1).map((r, i) => ({
    round: idx.round >= 0 ? (r[idx.round] || '1').trim() : '1',
    age: normaliseAge(r[idx.age]),
    number: idx.number >= 0 ? Number(r[idx.number]) || i + 1 : i + 1,
    question: (r[idx.question] || '').trim(),
    answer: (r[idx.answer] || '').trim(),
    wrong: idx.wrong.filter((w) => w >= 0).map((w) => (r[w] || '').trim()).filter(Boolean),
  })).filter((q) => q.question && q.answer);
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

// Returns { questions, source: 'sheet' | 'cache' | 'sample', error }.
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
  const questions = await fetchCsv(SAMPLE_URL);
  return { questions, source: 'sample', error };
}

function roundsIn(questions) {
  return [...new Set(questions.map((q) => q.round))].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

function questionsFor(questions, round, age) {
  return questions.filter((q) => q.round === round && q.age === age).sort((a, b) => a.number - b.number);
}
