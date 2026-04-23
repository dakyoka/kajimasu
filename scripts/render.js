import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import Handlebars from 'handlebars';

const OUTPUT_DIR = 'output';
const TEMPLATE_PATH = 'template.html';
const GAS_API_URL = process.env.GAS_API_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.0-flash';

if (!GAS_API_URL) {
  console.error('Missing GAS_API_URL env');
  process.exit(1);
}

async function main() {
  console.log('Fetching data from GAS...');
  const res = await fetch(GAS_API_URL);
  if (!res.ok) throw new Error(`GAS fetch failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`GAS error: ${data.error}`);

  const today = new Date(data.today + 'T00:00:00+09:00');
  console.log(`Today: ${data.today} (${data.weekday})`);
  console.log(`Masters: ${data.masters.length}, Logs: ${data.logs.length}, Context: ${(data.context || '').length}文字`);

  const scored = computeScores(data.masters, data.logs, today);

  let aiResult = null;
  if (GEMINI_API_KEY) {
    try {
      aiResult = await runAIPipeline(data.context || '', data.today, data.weekday, scored);
    } catch (err) {
      console.warn('⚠️ AI pipeline failed, falling back to rule-based');
      console.warn(err.message);
    }
  } else {
    console.log('GEMINI_API_KEY not set, using rule-based');
  }

  const top3 = pickFromScored(aiResult?.top3, scored);
  const bonus = pickFromScored(
    aiResult?.bonus?.map(b => ({ ...b, reason: null })),
    scored,
    top3
  );

  fillShortage(top3, scored, []);
  fillShortage(bonus, scored, top3);

  console.log('TOP3:', top3.map(c => c.name).join(', '));
  console.log('BONUS:', bonus.map(c => c.name).join(', '));

  const view = buildView(data, top3, bonus);

  const templateStr = await fs.readFile(TEMPLATE_PATH, 'utf8');
  const template = Handlebars.compile(templateStr);
  const html = template(view);

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUTPUT_DIR, 'latest.html'), html);

  console.log('Launching Puppeteer...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    await renderImage(browser, html, path.join(OUTPUT_DIR, 'latest.png'), {
      viewport: { width: 1280, height: 1500, deviceScaleFactor: 2 },
      type: 'png',
    });
    console.log('Original PNG saved');

    await renderImage(browser, html, path.join(OUTPUT_DIR, 'latest-preview.jpg'), {
      viewport: { width: 640, height: 800, deviceScaleFactor: 1 },
      type: 'jpeg',
      quality: 75,
    });
    console.log('Preview JPEG saved');
  } finally {
    await browser.close();
  }

  console.log('Done!');
}

// ========== AI パイプライン ==========

async function runAIPipeline(context, today, weekday, scored) {
  console.log('[AI Stage 1] Main AI proposing...');
  const draft = await stage1Propose(context, today, weekday, scored);
  console.log('[AI Stage 1] Draft:', summarize(draft));

  console.log('[AI Stage 2] Reviewers reviewing in parallel...');
  const [expertReview, tiredReview] = await Promise.all([
    stage2ReviewExpert(context, today, weekday, scored, draft),
    stage2ReviewTired(context, today, weekday, scored, draft),
  ]);
  console.log('[AI Stage 2] Expert:', expertReview.slice(0, 80).replace(/\n/g, ' '));
  console.log('[AI Stage 2] Tired :', tiredReview.slice(0, 80).replace(/\n/g, ' '));

  console.log('[AI Stage 3] Main AI finalizing...');
  const final = await stage3Finalize(context, today, weekday, scored, draft, expertReview, tiredReview);
  console.log('[AI Stage 3] Final:', summarize(final));

  return final;
}

async function stage1Propose(context, today, weekday, scored) {
  const prompt = `あなたは家庭の家事アシスタントです。世帯情報と家事状況を見て、今日のTOP3と余裕があれば追加でやる家事ボーナス3つを決めてください。

# 世帯情報
${context || '（コンテキスト未設定）'}

# 現在日時
${today}（${weekday}曜日）

# 家事一覧
${formatChoresForPrompt(scored)}

# 方針
- 推奨頻度からの超過を重視
- 曜日の特性も考慮
- 同ジャンル偏らせすぎない
- 理由文は50字前後、重要キーワードを **太字** で囲む

# 出力はJSONのみ
{
  "top3": [
    {"name": "家事名", "reason": "理由文（**強調**含む）"},
    {"name": "家事名", "reason": "..."},
    {"name": "家事名", "reason": "..."}
  ],
  "bonus": [{"name": "家事名"}, {"name": "家事名"}, {"name": "家事名"}]
}`;
  const text = await callGemini(prompt, { jsonOutput: true, temperature: 0.7 });
  return parseJsonSafe(text);
}

async function stage2ReviewExpert(context, today, weekday, scored, draft) {
  const prompt = `あなたは整理収納アドバイザーの資格を持つ家事のプロです。提案ドラフトにプロ視点のレビューコメントを書いてください。書き換え権限はありません。

# 世帯情報
${context}

# 今日
${today}（${weekday}曜日）

# 家事一覧
${formatChoresForPrompt(scored)}

# 提案ドラフト
${JSON.stringify(draft, null, 2)}

# レビュー観点
- 衛生面での見落とし
- 家事動線・効率
- 曜日特性（ゴミ、来客等）
- 理由文の説得力

# 出力（プレーンテキスト、300字以内）
「専門家として気になる点：」から始めて、1〜3点の具体的コメント。
suggest調で（「〜の検討を」など）。`;
  return await callGemini(prompt, { temperature: 0.6 });
}

async function stage2ReviewTired(context, today, weekday, scored, draft) {
  const prompt = `あなたは仕事と生活で疲れている、その世帯の住人です。提案ドラフトに「本当に今日できるか？」の現実チェックをコメントしてください。書き換え権限はありません。

# 世帯情報
${context}

# 今日
${today}（${weekday}曜日）

# 提案ドラフト
${JSON.stringify(draft, null, 2)}

# レビュー観点
- 合計所要時間の負担感
- 曜日の疲労度（金曜夜、土曜来客前等）
- 朝/夜の生活リズム
- 体調配慮（腰痛、手荒れ等）
- 「今日じゃなくていい」感のあるものが紛れ込んでないか

# 出力（プレーンテキスト、300字以内）
「疲れた自分として気になる点：」から始めて、1〜3点の具体的コメント。
suggest調で（「〜は軽めに済ませる手も」など）。`;
  return await callGemini(prompt, { temperature: 0.7 });
}

async function stage3Finalize(context, today, weekday, scored, draft, expertReview, tiredReview) {
  const prompt = `あなたは家庭の家事アシスタントです。ドラフト提案に2名のレビューが入りました。両方を踏まえて最終版を決定してください（決裁権はあなた）。

# 世帯情報
${context}

# 今日
${today}（${weekday}曜日）

# 家事一覧
${formatChoresForPrompt(scored)}

# ドラフト
${JSON.stringify(draft, null, 2)}

# 🧹 専門家のレビュー
${expertReview}

# 😮‍💨 疲れた自分のレビュー
${tiredReview}

# 指示
- 両レビューを踏まえて必要なら入れ替え/理由文調整
- 指摘を全部飲む必要はなく、あなたが判断
- 理由文はポジティブで具体的、50字前後、重要キーワードを **太字** で
- 家事名は必ず「家事一覧」の中のものと完全一致させる

# 出力はJSONのみ
{
  "top3": [
    {"name": "家事名", "reason": "..."},
    {"name": "家事名", "reason": "..."},
    {"name": "家事名", "reason": "..."}
  ],
  "bonus": [{"name": "家事名"}, {"name": "家事名"}, {"name": "家事名"}]
}`;
  const text = await callGemini(prompt, { jsonOutput: true, temperature: 0.7 });
  return parseJsonSafe(text);
}

async function callGemini(prompt, opts = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      ...(opts.jsonOutput && { responseMimeType: 'application/json' }),
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty response');
  return text;
}

function parseJsonSafe(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('Non-JSON response: ' + text.slice(0, 200));
}

function formatChoresForPrompt(scored) {
  return scored.map(c => {
    const last = c.daysAgo >= 999 ? '未記録' : `${c.daysAgo}日前`;
    const freq = c.weeklyFreq ? `週${c.weeklyFreq}回` : '';
    const min = c.minutes ? `${c.minutes}分` : '';
    const over = c.daysAgo >= 999
      ? ''
      : c.overDays > 0 ? `/+${c.overDays}日超過`
      : c.overDays === 0 ? '/ちょうど'
      : c.overDays === -1 ? '/明日目安' : '';
    return `- ${c.name}: ${freq}/${min}/前回${last}${over}`;
  }).join('\n');
}

function pickFromScored(aiList, scored, exclude = []) {
  if (!aiList || !Array.isArray(aiList)) return [];
  const excludeNames = new Set(exclude.map(c => c.name));
  return aiList.map(item => {
    const name = String(item.name || '').trim();
    const full = scored.find(c => c.name === name)
      || scored.find(c => c.name.includes(name) || name.includes(c.name));
    if (!full) return null;
    if (excludeNames.has(full.name)) return null;
    return { ...full, aiReason: item.reason || null };
  }).filter(Boolean);
}

function fillShortage(list, scored, exclude) {
  const needed = 3 - list.length;
  if (needed <= 0) return;
  const existing = new Set([...list, ...exclude].map(c => c.name));
  const fill = scored.filter(c => !existing.has(c.name)).slice(0, needed);
  list.push(...fill);
}

function summarize(obj) {
  return (obj?.top3 || []).map(t => t.name).join(',') +
    ' / ' + (obj?.bonus || []).map(b => b.name).join(',');
}

// ========== スコア計算（フォールバック用） ==========

function computeScores(masters, logs, today) {
  return masters
    .map(m => {
      const matchingLogs = logs.filter(l => l.chore === m.name);
      const latest = matchingLogs.length > 0
        ? new Date(Math.max(...matchingLogs.map(l => new Date(l.datetime).getTime())))
        : null;
      const daysAgo = latest
        ? Math.floor((today - latest) / (1000 * 60 * 60 * 24))
        : 999;
      const overDays = daysAgo - (m.cycleDays || 1);
      const score = daysAgo / (m.cycleDays || 1);
      return { ...m, daysAgo, overDays, score };
    })
    .sort((a, b) => b.score - a.score);
}

// ========== ビュー構築 ==========

function buildView(data, top3, bonus) {
  const dateObj = new Date(data.today + 'T00:00:00+09:00');
  const monthsEn = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const monthEn = monthsEn[dateObj.getMonth()];
  const day = dateObj.getDate();
  const fullDate = `${dateObj.getMonth() + 1}月${day}日 ${data.weekday}曜日`;

  const palettes = [
    { color: 'cyan1', bg: 'cyanbg' },
    { color: 'sky1',  bg: 'skybg'  },
    { color: 'indi1', bg: 'indibg' },
  ];

  const top3View = top3.map((c, i) => {
    const p = palettes[i];
    return {
      rank: i + 1,
      name: c.name,
      color: p.color,
      bg: p.bg,
      icon: getIcon(c.name),
      lastDaysAgo: c.daysAgo < 999 ? `前回 ${c.daysAgo}日前` : '初回',
      cycleText: c.weeklyFreq ? `週${formatFreq(c.weeklyFreq)}回目安` : `推奨 ${c.cycleDays || '?'}日サイクル`,
      cycleStatus: buildCycleStatus(c),
      reason: buildReason(c, p.color),
      minutes: c.minutes || 0,
    };
  });

  const heroChips = top3.map((c, i) => ({
    name: shortenName(c.name),
    color: palettes[i].color,
    bg: palettes[i].bg,
    icon: getIcon(c.name),
  }));

  const totalMinutes = top3.reduce((sum, c) => sum + (c.minutes || 0), 0);

  const bonusView = bonus.map(c => ({
    name: c.name,
    icon: getIcon(c.name),
  }));

  return {
    greeting: 'おはようございます。',
    date: { day, monthEn, fullDate },
    hero: { chips: heroChips, totalMinutes },
    top3: top3View,
    bonus: bonusView,
  };
}

function buildCycleStatus(chore) {
  if (chore.daysAgo >= 999) return '未記録';
  if (chore.overDays > 0) return `+${chore.overDays}日 超過`;
  if (chore.overDays === 0) return '今日が推奨';
  if (chore.overDays === -1) return '明日が期限';
  return `あと${Math.abs(chore.overDays)}日`;
}

function buildReason(chore, color) {
  if (chore.aiReason) {
    return formatAiReason(chore.aiReason, color);
  }
  const freqDisplay = chore.weeklyFreq
    ? `週${formatFreq(chore.weeklyFreq)}回`
    : `${chore.cycleDays}日サイクル`;

  if (chore.daysAgo >= 999) {
    return `まだ記録がありません。${freqDisplay}のペースでスタート。`;
  }
  if (chore.overDays > 0) {
    return `前回から${chore.daysAgo}日経過、${freqDisplay}のペースを<span class="font-bold text-${color}">${chore.overDays}日超過</span>。今日が動き時。`;
  }
  if (chore.overDays === 0) {
    return `<span class="font-bold text-${color}">${freqDisplay}のペースちょうど</span>。今日やると次のサイクルまで気が楽に。`;
  }
  if (chore.overDays === -1) {
    return `<span class="font-bold text-${color}">明日が目安</span>。先取りで今日やれば、明日以降に余裕が生まれる。`;
  }
  return `前回から${chore.daysAgo}日。<span class="font-bold text-${color}">${chore.minutes}分で済む</span>ので、手が空いた時に。`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatAiReason(aiText, color) {
  const safe = escapeHtml(aiText);
  return safe.replace(/\*\*(.+?)\*\*/g, `<span class="font-bold text-${color}">$1</span>`);
}

function formatFreq(freq) {
  return Number.isInteger(freq) ? String(freq) : freq.toFixed(1);
}

function shortenName(name) {
  if (name.length <= 6) return name;
  const shortMap = {
    'リビングの掃除機がけ': '掃除機',
    'お風呂のカビ予防': '風呂カビ',
    '洗濯物取り込み&畳む': '洗濯畳み',
    '冷蔵庫の中身チェック': '冷蔵庫',
    'クイックルワイパー': 'ワイパー',
    '玄関の掃き掃除': '玄関掃き',
    '観葉植物の水やり': '水やり',
    '机周りの整理': '机整理',
  };
  return shortMap[name] || name.slice(0, 6);
}

function getIcon(name) {
  const map = [
    { pattern: /洗濯機/, icon: 'washing-machine' },
    { pattern: /洗濯|衣|畳/, icon: 'shirt' },
    { pattern: /掃除機|フローリング|ワイパー|クイックル/, icon: 'wind' },
    { pattern: /風呂|浴|カビ/, icon: 'bath' },
    { pattern: /トイレ/, icon: 'toilet' },
    { pattern: /ゴミ|ごみ/, icon: 'trash-2' },
    { pattern: /冷蔵庫/, icon: 'refrigerator' },
    { pattern: /植物|水やり|花|観葉/, icon: 'flower-2' },
    { pattern: /玄関|掃き/, icon: 'door-open' },
    { pattern: /食器|シンク|皿|洗い/, icon: 'utensils' },
    { pattern: /机|整理|片付/, icon: 'layout-grid' },
  ];
  for (const m of map) if (m.pattern.test(name)) return m.icon;
  return 'sparkles';
}

// ========== Puppeteer ==========

async function renderImage(browser, html, outPath, opts) {
  const page = await browser.newPage();
  await page.setViewport(opts.viewport);
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () => document.querySelectorAll('i[data-lucide]').length === 0 && window.__iconsReady === true,
    { timeout: 15000 }
  );
  await new Promise(r => setTimeout(r, 500));

  const rect = await page.evaluate(() => {
    const el = document.querySelector('[data-capture-root]');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  const screenshotOpts = {
    path: outPath,
    clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
  };
  if (opts.type === 'jpeg') {
    screenshotOpts.type = 'jpeg';
    screenshotOpts.quality = opts.quality || 75;
  }
  await page.screenshot(screenshotOpts);
  await page.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
