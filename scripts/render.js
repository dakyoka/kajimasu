import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import Handlebars from 'handlebars';

const OUTPUT_DIR = 'output';
const TEMPLATE_PATH = 'template.html';
const GAS_API_URL = process.env.GAS_API_URL;

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
  console.log(`Masters: ${data.masters.length}, Logs: ${data.logs.length}`);

  const scored = computeScores(data.masters, data.logs, today);
  const top3 = scored.slice(0, 3);
  const bonus = scored.slice(3, 6);

  console.log('TOP3:', top3.map(c => `${c.name}(${c.daysAgo}日前)`).join(', '));
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
    // 高解像度 PNG (LINE original)
    await renderImage(browser, html, path.join(OUTPUT_DIR, 'latest.png'), {
      viewport: { width: 1280, height: 1500, deviceScaleFactor: 2 },
      type: 'png',
    });
    console.log('Original PNG saved');

    // 低解像度 JPEG (LINE preview, < 1MB)
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

main().catch(e => {
  console.error(e);
  process.exit(1);
});
