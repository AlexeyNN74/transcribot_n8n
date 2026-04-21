const db = require('better-sqlite3')('/data/db/transcribe.db');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';
const CHUNK_SIZE = 15000;

const DEFAULT_SYSTEM_PROMPT = `Ты — программа-конспектировщик аудиозаписей. Ты получаешь транскрипцию группового занятия по психологии и возвращаешь структурированный конспект.
Формат ответа:
Саммари:
[3-5 предложений — о чём запись в целом]
Ключевые темы:
- [тема 1]
- [тема 2]
Участники:
- [имена и роли, если упоминаются в записи]
Основные тезисы:
- [тезис 1]
- [тезис 2]
Правила:
- Пиши только конспект
- Не обращайся к собеседнику
- Сохраняй имена и факты точно
- Язык — русский`;

function smartSample(text) {
  if (text.length <= CHUNK_SIZE * 3) return text;
  const start = text.slice(0, CHUNK_SIZE);
  const mid = Math.floor(text.length / 2 - CHUNK_SIZE / 2);
  const middle = text.slice(mid, mid + CHUNK_SIZE);
  const end = text.slice(-CHUNK_SIZE);
  return '=== НАЧАЛО ЗАПИСИ ===\n' + start + '\n\n=== СЕРЕДИНА ЗАПИСИ ===\n' + middle + '\n\n=== КОНЕЦ ЗАПИСИ ===\n' + end;
}

async function regen(job) {
  console.log('Processing:', job.original_name, '(' + job.result_clean.length + ' chars)');
  const sampled = smartSample(job.result_clean);
  const systemPrompt = job.prompt_text || DEFAULT_SYSTEM_PROMPT;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Составь конспект этой аудиозаписи:\n\n' + sampled }],
    }),
  });

  if (!r.ok) {
    console.error('ERROR HTTP', r.status);
    return;
  }

  const data = await r.json();
  const summary = data.content.map(c => c.text || '').join('');
  const now = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  const resultTxt = 'Обработано: ' + now + '\n' + '\u2550'.repeat(60) + '\n' + summary;

  db.prepare('UPDATE jobs SET result_txt = ? WHERE id = ?').run(resultTxt, job.id);
  console.log('OK:', job.original_name, '->', summary.length, 'chars');
}

async function main() {
  const jobs = db.prepare("SELECT id, original_name, result_clean, prompt_text FROM jobs WHERE status='completed' AND length(result_txt) < 200").all();
  console.log('Found', jobs.length, 'jobs to regenerate');
  for (const job of jobs) {
    await regen(job);
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('Done!');
}

main().catch(e => console.error(e));
