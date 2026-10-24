// Supabase connection. The anon key is public by design: the database's security rules decide what it can do.
const SUPABASE_URL = 'https://fpgrghfzlpfxoshlamjo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZwZ3JnaGZ6bHBmeG9zaGxhbWpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI4MjM3NzIsImV4cCI6MjEwODM5OTc3Mn0.5bvmtAedupxAsj_KzciPdtQ0sXOaa_WuQwGEyoNqewU';
const DB_PAGE = 1000; // Supabase returns at most 1,000 rows per request
const DB_TIMEOUT_MS = 8000;

async function dbGet(path, from, to) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DB_TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, Range: `${from}-${to}` },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`The question database returned error ${res.status}.`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Every active question in the database, as the same rows the CSV loader produces.
async function fetchDbQuestions() {
  const path = 'questions?select=topic,age_band,grade,question,answer,wrong&active=eq.true&kind=eq.text&order=id';
  const rows = [];
  for (let from = 0; ; from += DB_PAGE) {
    const page = await dbGet(path, from, from + DB_PAGE - 1);
    rows.push(...page);
    if (page.length < DB_PAGE) break;
  }
  const table = [['topic', 'age', 'grade', 'question', 'answer', 'wrong1', 'wrong2', 'wrong3']]
    .concat(rows.map((r) => [r.topic, r.age_band, String(r.grade), r.question, r.answer, ...(r.wrong || [])]));
  const questions = rowsToQuestions(table);
  if (!questions.length) throw new Error('The question database is empty.');
  return questions;
}

// Song clips play 30-second Apple Music previews. Their terms are about promoting songs, so the app
// store build turns them off; hum-it rounds don't need them.
const SONG_CLIPS_ALLOWED = true;
