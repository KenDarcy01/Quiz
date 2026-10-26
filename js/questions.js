// Loads questions from Supabase (or the bundled copy when offline) plus a Google Sheet, and picks them by age, grade and topic.

// The family question sheet, used when no other link is set in Settings.
const DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1Q-vsC1R0agSt0r20phZ5n2Lfsm-e5x_Qtfa-WhVc-HI/edit';
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
  let res;
  try { res = await fetch(url, { cache: 'no-store' }); } catch {
    throw new Error('The family sheet could not be reached. Check it is shared as "Anyone with the link: Viewer".');
  }
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

// The question bank from Supabase, falling back to the bundled copy when there's no signal.
// Returns { questions, db: true | false }.
async function loadBank() {
  try {
    return { questions: await fetchDbQuestions(), db: true };
  } catch {
    return { questions: await fetchCsv(BUNDLED_URL), db: false };
  }
}

// The question bank plus the family's own questions from the sheet.
// Returns { questions, db, source: 'sheet' | 'cache' | 'bundled', error }.
async function loadQuestions(sheetUrl) {
  const { questions: bundled, db } = await loadBank();
  const url = sheetCsvUrl(sheetUrl);
  if (!url) return { questions: bundled, db, source: 'bundled', error: null };
  let own = [];
  let source = 'sheet';
  let error = null;
  try {
    own = await fetchCsv(url);
    writeCache({ url, questions: own, at: Date.now() });
  } catch (e) {
    error = e.message || String(e);
    const cached = readCache();
    if (cached && cached.url === url) { own = cached.questions; source = 'cache'; } else source = 'bundled';
  }
  const ids = new Set(bundled.map((q) => q.id));
  own.forEach((q) => { q.own = true; });
  return { questions: bundled.concat(own.filter((q) => !ids.has(q.id))), db, source, error };
}

function topicsIn(questions) {
  return [...new Set(questions.map((q) => q.topic))].sort((a, b) => a.localeCompare(b));
}

// A topic can sit under a parent, written "Sports / Rugby". Picking the parent ("Sports") plays all
// of its sub-topics, so a new sub-topic only needs questions with that topic name.
const TOPIC_SEP = ' / ';
function topicParent(topic) {
  return topic.split(TOPIC_SEP)[0];
}
function topicMatches(questionTopic, pick) {
  return !pick || questionTopic === pick || questionTopic.startsWith(pick + TOPIC_SEP);
}

// How a topic is shown during a game: the last two levels, "Sports · GAA".
function topicLabel(topic) {
  return topic.split(TOPIC_SEP).slice(-2).join(' · ');
}

// The <option>s for a topic picker: plain topics first, then a group for each parent with "All …",
// its sub-topics, and any sub-sub-topics indented under theirs ("Harry Potter – all", then each book).
function topicOptions(topics, selected) {
  const opt = (value, label) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
  const plain = topics.filter((t) => !t.includes(TOPIC_SEP));
  const nested = topics.filter((t) => t.includes(TOPIC_SEP));
  const parents = [...new Set(nested.map(topicParent))].filter((t) => !plain.includes(t));
  // Every level below a parent, including in-between ones with no questions of their own.
  const nodes = new Set();
  nested.forEach((t) => {
    const parts = t.split(TOPIC_SEP);
    for (let n = 2; n <= parts.length; n++) nodes.add(parts.slice(0, n).join(TOPIC_SEP));
  });
  const sorted = [...nodes].sort((a, b) => a.localeCompare(b));
  const indent = '\u00a0\u00a0\u00a0';
  return opt('', 'Mixed topics') + plain.map((t) => opt(t, t)).join('')
    + parents.map((parent) => `<optgroup label="${esc(parent)}">${opt(parent, `All ${parent.toLowerCase()}`)}${
      sorted.filter((t) => t.startsWith(parent + TOPIC_SEP)).map((t) => {
        const parts = t.split(TOPIC_SEP);
        const hasKids = sorted.some((x) => x.startsWith(t + TOPIC_SEP));
        return opt(t, indent.repeat(parts.length - 2) + parts[parts.length - 1] + (hasKids ? ' – all' : ''));
      }).join('')
    }</optgroup>`).join('');
}

// Questions that suit a player of this age, in the chosen topic and grade range.
function poolFor(questions, age, topic, grades) {
  const years = playerAge(age);
  return questions.filter((q) => years >= q.age.min && years <= q.age.max
    && topicMatches(q.topic, topic)
    && grades.includes(q.grade));
}
