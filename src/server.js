const fs = require("fs");
const path = require("path");
const express = require("express");
const cheerio = require("cheerio");
const { spawn } = require("child_process");
const { normalizeQuotes } = require("./utils");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "..", "data");
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const REPORT_PATH = path.join(DATA_DIR, "report.json");
const CONFIG_PATH = path.join(__dirname, "..", "config.json");
const CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

const CRAWL_SCRIPT = path.join(__dirname, "crawl.js");

let crawlProcess = null;
let crawlStatus = {
  state: "idle",
  progress: 0,
  message: "",
  updatedAt: new Date().toISOString(),
};

function setCrawlStatus(partial) {
  crawlStatus = {
    ...crawlStatus,
    ...partial,
    updatedAt: new Date().toISOString(),
  };
}

// ── вспомогательные функции ─────────────────────────────────────────────
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function isHtmlContentType(ct = "") {
  return String(ct).toLowerCase().includes("text/html");
}

function normalizePath(href, base) {
  try {
    const u = new URL(href, base);
    if (u.origin !== new URL(base).origin) return null;
    let p = u.pathname;
    if (!p.startsWith("/")) p = "/" + p;
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    return p;
  } catch {
    return null;
  }
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function isPaginationPath(pathname, search = "") {
  if (/(^|\/)page\/\d+(\/|$)/i.test(pathname)) return true;
  if (/([?&])page=\d+(\b|&|$)/i.test(search)) return true;
  return false;
}

async function fetchFinal(url, timeoutMs = 15000, maxRedirects = 10) {
  let current = url;
  const chain = [];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    for (let i = 0; i < maxRedirects; i++) {
      const res = await fetch(current, {
        redirect: "manual",
        signal: ctrl.signal,
      });
      const status = res.status;
      const ct = res.headers.get("content-type") || "";
      const loc = res.headers.get("location");

      if (REDIRECT_CODES.has(status) && loc) {
        const next = new URL(loc, current).href;
        chain.push({ status, from: current, to: next });
        current = next;
        continue;
      }

      let html = "";
      if (isHtmlContentType(ct)) html = await res.text();
      return { status, contentType: ct, html, url: current, chain };
    }
    return {
      status: 0,
      contentType: "",
      html: "",
      url: current,
      chain,
      error: "Too many redirects",
    };
  } catch (e) {
    return {
      status: 0,
      contentType: "",
      html: "",
      url: current,
      chain,
      error: String(e),
    };
  } finally {
    clearTimeout(t);
  }
}

async function parsePage(base, p) {
  const startUrl = new URL(p, base).href;
  const {
    status,
    contentType,
    html,
    url: finalUrl,
    chain,
  } = await fetchFinal(startUrl, CFG.TIMEOUT_MS);
  if (!isHtmlContentType(contentType)) {
    return {
      status,
      title: "",
      h1: "",
      description: "",
      links: [],
      redirected: chain.length > 0,
    };
  }

  const $ = cheerio.load(html || "");
  const title = ($("title").first().text() || "").trim();
  const h1 = ($("h1").first().text() || "").replace(/\s+/g, " ").trim();
  const desc = ($('meta[name="description"]').attr("content") || "")
    .replace(/\s+/g, " ")
    .trim();
  let links = [];

  $("a[href]").each((_, a) => {
    const href = String($(a).attr("href") || "");
    let linkUrl;
    try {
      linkUrl = new URL(href, base);
    } catch {
      linkUrl = null;
    }
    if (!linkUrl) return;
    if (linkUrl.origin !== new URL(base).origin) return;
    if (!isHtmlContentType("text/html")) return;
    if (isPaginationPath(linkUrl.pathname, linkUrl.search)) return;
    const norm = normalizePath(linkUrl.pathname, base);
    if (norm) links.push(norm);
  });
  links = uniq(links);

  return {
    status,
    title,
    h1,
    description: desc,
    links,
    redirected: chain.length > 0,
    finalPath: normalizePath(new URL(finalUrl).pathname, base) || p,
  };
}

// ── отдать отчёт ─────────────────────────────────────────────────────────
app.get("/api/report", (req, res) => {
  if (!fs.existsSync(REPORT_PATH)) {
    return res
      .status(404)
      .json({ error: "report.json not found. Run npm run crawl first." });
  }
  const data = JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));
  res.json(data);
});

// ── статус краулинга ─────────────────────────────────────────────────────
app.get("/api/crawl/status", (req, res) => {
  res.json(crawlStatus);
});

function startCrawl() {
  if (crawlProcess) return;

  setCrawlStatus({ state: "running", progress: 5, message: "Запуск краулинга" });

  crawlProcess = spawn(process.execPath, [CRAWL_SCRIPT], {
    cwd: path.join(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  const handleLine = (line) => {
    const text = line.trim();
    if (!text) return;
    console.log(`[crawl] ${text}`);
    if (text.includes("Sitemap seeds")) {
      setCrawlStatus({ progress: 20, message: "Обработка sitemap" });
    } else if (text.includes("Crawl OLD")) {
      setCrawlStatus({ progress: 35, message: "Сканирование старой версии" });
    } else if (text.includes("OLD final HTML pages")) {
      setCrawlStatus({ progress: 55, message: "Сбор данных старой версии" });
    } else if (text.includes("Check NEW")) {
      setCrawlStatus({ progress: 75, message: "Проверка новой версии" });
    } else if (text.includes("Saved:")) {
      setCrawlStatus({ progress: 95, message: "Финализация отчёта" });
    }
  };

  crawlProcess.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    const parts = stdoutBuf.split(/\r?\n/);
    stdoutBuf = parts.pop() || "";
    for (const part of parts) handleLine(part);
  });

  crawlProcess.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    console.error(`[crawl:err] ${text.trim()}`);
  });

  crawlProcess.on("error", (err) => {
    console.error("Failed to start crawl process", err);
    crawlProcess = null;
    setCrawlStatus({ state: "error", progress: 0, message: "Не удалось запустить краулинг" });
  });

  crawlProcess.on("exit", (code) => {
    crawlProcess = null;
    if (code === 0) {
      setCrawlStatus({ state: "completed", progress: 100, message: "Краулинг завершён" });
      console.log("Crawl finished successfully. Restarting server...");
      setTimeout(() => {
        setCrawlStatus({ state: "restarting", message: "Перезапуск сервера" });
        setTimeout(() => process.exit(0), 300);
      }, 700);
    } else {
      setCrawlStatus({
        state: "error",
        progress: 0,
        message: `Краулинг завершился с ошибкой (код ${code})`,
      });
      console.error(`Crawl process exited with code ${code}`);
    }
  });
}

// ── запустить краулинг ───────────────────────────────────────────────────
app.post("/api/crawl/start", (req, res) => {
  if (crawlProcess) {
    return res
      .status(409)
      .json({ error: "Crawl already running", status: crawlStatus });
  }
  startCrawl();
  res.json(crawlStatus);
});

// ── обновить конкретную запись ──────────────────────────────────────────
app.get("/api/refresh", async (req, res) => {
  const p = req.query.path;
  if (!p) return res.status(400).json({ error: "path parameter is required" });

  if (!fs.existsSync(REPORT_PATH)) {
    return res
      .status(404)
      .json({ error: "report.json not found. Run npm run crawl first." });
  }
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));

  // обновляем старую и новую версию
  const oldData = await parsePage(report.meta.oldBase, p);
  const newData = await parsePage(report.meta.newBase, p);

  // считаем различия
  const titleMatch =
    normalizeQuotes(oldData.title) === normalizeQuotes(newData.title);
  const h1Match = normalizeQuotes(oldData.h1) === normalizeQuotes(newData.h1);
  const descMatch =
    normalizeQuotes(oldData.description) === normalizeQuotes(newData.description);
  const linksOld = new Set(oldData.links);
  const linksNew = new Set(newData.links);
  const linksMissingInNew = [...linksOld].filter((x) => !linksNew.has(x));
  const linksExtraInNew = [...linksNew].filter((x) => !linksOld.has(x));

  // обновляем запись
  report.pages[p] = {
    old: {
      status: oldData.status,
      title: oldData.title,
      h1: oldData.h1,
      description: oldData.description,
      linkCount: oldData.links.length,
      redirected: oldData.redirected,
    },
    new: {
      status: newData.status,
      title: newData.title,
      h1: newData.h1,
      description: newData.description,
      linkCount: newData.links.length,
      redirected: newData.redirected,
      finalPath: newData.finalPath || p,
    },
    diff: {
      titleMatch,
      h1Match,
      descMatch,
      linksMissingInNewCount: linksMissingInNew.length,
      linksExtraInNewCount: linksExtraInNew.length,
      sampleMissingInNew: linksMissingInNew.slice(0, 100),
      sampleExtraInNew: linksExtraInNew.slice(0, 100),
      redirectToDifferentPath:
        newData.redirected && (newData.finalPath || p) !== p,
      consolidatedRedirect: false, // если нужно — вычисляйте отдельно
    },
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  res.json({ path: p, data: report.pages[p] });
});

// ── подключение статических файлов ──────────────────────────────────────
app.use(express.static(PUBLIC_DIR));

// ── запуск сервера ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
