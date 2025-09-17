const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const cheerio = require("cheerio");
const { XMLParser } = require("fast-xml-parser");
const {
  normalizePath,
  uniq,
  isHtmlPathname,
  isPaginationPath,
  normalizeQuotes,
} = require("./utils");

const CFG = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8")
);

const DATA_DIR = path.join(__dirname, "..", "data");
const REPORT_PATH = path.join(DATA_DIR, "report.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

const isHtmlContentType = (ct = "") =>
  String(ct).toLowerCase().includes("text/html");

async function fetchFinal(url, timeoutMs, maxRedirects = 10) {
  let current = url;
  const chain = [];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
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

/* ---- sitemap loader (sitemap, index, .xml.gz) ---- */
async function fetchBuffer(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctrl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get("content-type") || "";
    const enc = res.headers.get("content-encoding") || "";
    return {
      ok: res.ok,
      status: res.status,
      buf,
      contentType: ct,
      encoding: enc,
      url: res.url,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      buf: Buffer.alloc(0),
      contentType: "",
      encoding: "",
      error: String(e),
    };
  } finally {
    clearTimeout(t);
  }
}
function gunzipMaybe(buf, url, contentType, encoding) {
  try {
    const isGz =
      /\.gz($|\?)/i.test(url) ||
      /gzip/i.test(encoding) ||
      /application\/gzip/i.test(contentType);
    return isGz ? zlib.gunzipSync(buf) : buf;
  } catch {
    return buf;
  }
}
async function collectSitemapUrls(sitemapUrl, base, timeoutMs, limit = 200000) {
  if (!sitemapUrl) return { fromSitemap: [], rawCount: 0 };
  const origin = new URL(base).origin;
  const seenIndex = new Set();
  const found = new Set();
  const parser = new XMLParser({ ignoreAttributes: false });

  async function loadOne(url) {
    if (seenIndex.size + found.size > limit) return;
    const r = await fetchBuffer(url, timeoutMs);
    if (!r.ok) return;
    const body = gunzipMaybe(r.buf, url, r.contentType, r.encoding).toString(
      "utf8"
    );
    let xml;
    try {
      xml = parser.parse(body);
    } catch {
      return;
    }

    // urlset
    if (xml && xml.urlset && xml.urlset.url) {
      const items = Array.isArray(xml.urlset.url)
        ? xml.urlset.url
        : [xml.urlset.url];
      for (const it of items) {
        const loc = String(it.loc || it.LOC || "").trim();
        if (!loc) continue;
        try {
          const u = new URL(loc, url);
          if (u.origin !== origin) continue;
          const np = normalizePath(u.pathname, base);
          if (!np) continue;
          if (!isHtmlPathname(u.pathname)) continue;
          if (isPaginationPath(u.pathname, u.search)) continue;
          found.add(np);
        } catch {}
      }
      return;
    }
    // sitemapindex
    if (xml && xml.sitemapindex && xml.sitemapindex.sitemap) {
      const items = Array.isArray(xml.sitemapindex.sitemap)
        ? xml.sitemapindex.sitemap
        : [xml.sitemapindex.sitemap];
      for (const it of items) {
        const loc = String(it.loc || it.LOC || "").trim();
        if (!loc) continue;
        try {
          const u = new URL(loc, url);
          if (seenIndex.has(u.href)) continue;
          seenIndex.add(u.href);
          await loadOne(u.href);
        } catch {}
      }
    }
  }

  try {
    await loadOne(sitemapUrl);
  } catch {}
  return { fromSitemap: Array.from(found).sort(), rawCount: found.size };
}

/* ---- crawl old (финальные HTML) ---- */
async function crawlSite(base, startPaths, maxPages, sitemapSeed = []) {
  const origin = new URL(base).origin;
  const visited = new Set();
  const queued = new Set();
  const queue = [];
  const enqueue = (np) => {
    if (np && !queued.has(np)) {
      queued.add(np);
      queue.push(np);
    }
  };

  for (const sp of startPaths) {
    const np = normalizePath(sp, base);
    if (np && !isPaginationPath(np)) enqueue(np);
  }
  for (const sp of sitemapSeed) enqueue(sp);

  const pages = {};
  while (queue.length && visited.size < maxPages) {
    const pathItem = queue.shift();
    const startUrl = new URL(pathItem, base).href;
    const {
      status,
      contentType,
      html,
      url: finalUrl,
      chain,
    } = await fetchFinal(startUrl, CFG.TIMEOUT_MS);

    if (new URL(finalUrl).origin !== origin) continue;
    const u = new URL(finalUrl);
    const finalNormPath = normalizePath(u.pathname, base);
    if (isPaginationPath(u.pathname, u.search)) continue;
    if (!isHtmlContentType(contentType)) continue;
    if (!finalNormPath || visited.has(finalNormPath)) continue;
    visited.add(finalNormPath);

    // parse & enqueue
    let title = "",
      h1 = "",
      description = "",
      links = [];
    if (html) {
      const $ = cheerio.load(html);
      title = ($("title").first().text() || "").trim();
      h1 = ($("h1").first().text() || "").replace(/\s+/g, " ").trim();
      description = ($('meta[name="description"]').attr("content") || "")
        .replace(/\s+/g, " ")
        .trim();

      $("a[href]").each((_, a) => {
        const href = String($(a).attr("href") || "");
        let linkUrl;
        try {
          linkUrl = new URL(href, base);
        } catch {
          linkUrl = null;
        }
        if (!linkUrl) return;
        if (linkUrl.origin !== origin) return;
        if (!isHtmlPathname(linkUrl.pathname)) return;
        if (isPaginationPath(linkUrl.pathname, linkUrl.search)) return;
        const norm = normalizePath(linkUrl.pathname, base);
        if (norm) {
          links.push(norm);
          enqueue(norm);
        }
      });
      links = uniq(links);
    }

    pages[finalNormPath] = {
      status,
      contentType,
      isHtml: true,
      title,
      h1,
      description,
      links,
      redirected: chain.length > 0,
      redirected301: chain.some((h) => h.status === 301),
    };
  }
  return { pages, count: Object.keys(pages).length };
}

const isTrivialSlashRedirect = (fromPath, toPath) =>
  !!fromPath &&
  !!toPath &&
  (fromPath === toPath ||
    fromPath + "/" === toPath ||
    fromPath === toPath + "/");

function targetPathsFromConfirmedHtml(pages) {
  return Object.keys(pages).sort();
}

/* ---- main ---- */
(async () => {
  // sitemap сиды (опционально)
  let sitemapSeed = [];
  if (CFG.OLD_SITEMAP) {
    const { fromSitemap } = await collectSitemapUrls(
      CFG.OLD_SITEMAP,
      CFG.OLD_BASE,
      CFG.TIMEOUT_MS
    );
    sitemapSeed = fromSitemap;
    console.log("Sitemap seeds:", fromSitemap.length);
  }

  console.log("Crawl OLD:", CFG.OLD_BASE);
  const oldRes = await crawlSite(
    CFG.OLD_BASE,
    CFG.START_PATHS,
    CFG.MAX_PAGES,
    sitemapSeed
  );
  console.log("OLD final HTML pages:", oldRes.count);

  const targetPaths = targetPathsFromConfirmedHtml(oldRes.pages);

  console.log("Check NEW:", CFG.NEW_BASE);
  const newPages = {};
  for (const p of targetPaths) {
    const startUrl = new URL(p, CFG.NEW_BASE).href;
    const {
      status,
      contentType,
      html,
      url: finalUrl,
      chain,
    } = await fetchFinal(startUrl, CFG.TIMEOUT_MS);

    const nf = normalizePath(new URL(finalUrl).pathname, CFG.NEW_BASE);

    let title = "",
      h1 = "",
      description = "",
      links = [];
    if (isHtmlContentType(contentType) && html) {
      const $ = cheerio.load(html);
      title = ($("title").first().text() || "").trim();
      h1 = ($("h1").first().text() || "").replace(/\s+/g, " ").trim();
      description = ($('meta[name="description"]').attr("content") || "")
        .replace(/\s+/g, " ")
        .trim();

      $("a[href]").each((_, a) => {
        const href = String($(a).attr("href") || "");
        let linkUrl;
        try {
          linkUrl = new URL(href, CFG.NEW_BASE);
        } catch {
          linkUrl = null;
        }
        if (!linkUrl) return;
        if (linkUrl.origin !== new URL(CFG.NEW_BASE).origin) return;
        if (!isHtmlPathname(linkUrl.pathname)) return;
        if (isPaginationPath(linkUrl.pathname, linkUrl.search)) return;
        const norm = normalizePath(linkUrl.pathname, CFG.NEW_BASE);
        if (norm) links.push(norm);
      });
      links = uniq(links);
    }

    newPages[p] = {
      status,
      contentType,
      isHtml: isHtmlContentType(contentType),
      title,
      h1,
      description,
      links,
      redirected: chain.length > 0,
      redirected301: chain.some((h) => h.status === 301),
      finalPath: nf || p,
    };
  }

  // --- авто-детект «консолидации» (многие → один) без конфигов ---
  const bucket = {}; // finalPath -> count of sources (301 to different path, non-trivial)
  for (const p of targetPaths) {
    const np = newPages[p];
    if (!np || !np.redirected301) continue;
    const fp = np.finalPath || p;
    if (isTrivialSlashRedirect(p, fp)) continue;
    bucket[fp] = (bucket[fp] || 0) + 1;
  }
  // считаем консолидацией, если 2+ источника ведут на один финальный путь
  const consolidatedTargets = new Set(
    Object.entries(bucket)
      .filter(([, c]) => c >= 2)
      .map(([k]) => k)
  );

  // формируем отчёт
  const report = {
    meta: {
      oldBase: CFG.OLD_BASE,
      newBase: CFG.NEW_BASE,
      generatedAt: new Date().toISOString(),
      consolidatedTargets: Array.from(consolidatedTargets),
      topRedirectBuckets: Object.fromEntries(
        Object.entries(bucket)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 50)
      ),
    },
    paths: targetPaths,
    pages: {},
  };

  for (const p of targetPaths) {
    const oldP = oldRes.pages[p] || null;
    const newP = newPages[p] || null;

    const titleMatch = normalizeQuotes(oldP?.title) === normalizeQuotes(newP?.title);
    const h1Match = normalizeQuotes(oldP?.h1) === normalizeQuotes(newP?.h1);
    const descMatch =
      normalizeQuotes(oldP?.description) === normalizeQuotes(newP?.description);

    const finalPath = newP?.finalPath || p;
    const redirectToDifferentPath = !!(
      newP?.redirected301 && !isTrivialSlashRedirect(p, finalPath)
    );
    const consolidatedRedirect = !!(
      redirectToDifferentPath && consolidatedTargets.has(finalPath)
    );

    report.pages[p] = {
      old: {
        status: oldP?.status || 0,
        title: oldP?.title || "",
        h1: oldP?.h1 || "",
        description: oldP?.description || "",
      },
      new: {
        status: newP?.status || 0,
        title: newP?.title || "",
        h1: newP?.h1 || "",
        description: newP?.description || "",
        finalPath: finalPath,
        redirected: !!newP?.redirected,
        redirected301: !!newP?.redirected301,
      },
      diff: {
        titleMatch,
        h1Match,
        descMatch,
        redirectToDifferentPath, // 301 на другой путь (строго, без слеша-кейсов)
        consolidatedRedirect, // авто-склейка (2+ источника на один путь)
      },
    };
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log("Saved:", REPORT_PATH);
})();
