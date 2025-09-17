const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const DATA_DIR = path.join(__dirname, '..', 'data');
const REPORT_PATH = path.join(DATA_DIR, 'report.json');
const SHOTS_DIR = path.join(DATA_DIR, 'shots');

if (!fs.existsSync(REPORT_PATH)) {
  console.error('report.json не найден. Сначала запустите: npm run crawl');
  process.exit(1);
}
if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });

function safeName(p) {
  return p === '/' ? 'root' : p.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
}

async function screenshotPage(page, url, outPath) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: CFG.TIMEOUT_MS || 15000 });
  await page.screenshot({ path: outPath, fullPage: true });
}

(async () => {
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();

  for (const p of report.paths) {
    const oldUrl = new URL(p, report.meta.oldBase).href;
    const newUrl = new URL(p, report.meta.newBase).href;

    const dir = path.join(SHOTS_DIR, safeName(p));
    fs.mkdirSync(dir, { recursive: true });

    const oldPng = path.join(dir, 'old.png');
    const newPng = path.join(dir, 'new.png');
    const diffPng = path.join(dir, 'diff.png');

    try {
      await screenshotPage(page, oldUrl, oldPng);
      await screenshotPage(page, newUrl, newPng);

      const img1 = PNG.sync.read(fs.readFileSync(oldPng));
      const img2 = PNG.sync.read(fs.readFileSync(newPng));
      const w = Math.min(img1.width, img2.width);
      const h = Math.min(img1.height, img2.height);
      const crop1 = new PNG({ width: w, height: h });
      const crop2 = new PNG({ width: w, height: h });

      PNG.bitblt(img1, crop1, 0, 0, w, h, 0, 0);
      PNG.bitblt(img2, crop2, 0, 0, w, h, 0, 0);

      const diff = new PNG({ width: w, height: h });
      const mismatched = pixelmatch(crop1.data, crop2.data, diff.data, w, h, { threshold: 0.1 });
      fs.writeFileSync(diffPng, PNG.sync.write(diff));

      report.pages[p].visual = {
        screenshots: true,
        mismatchPixels: mismatched,
        width: w,
        height: h
      };
      console.log('SHOT OK:', p);
    } catch (e) {
      console.warn('SHOT FAIL:', p, e.message);
      if (!report.pages[p]) report.pages[p] = {};
      report.pages[p].visual = { screenshots: false };
    }
  }

  await browser.close();
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log('Visual data updated in report.json');
})();