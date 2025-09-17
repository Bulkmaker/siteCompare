const { URL } = require("url");

function normalizePath(href, base) {
  try {
    const u = new URL(href, base);
    if (u.origin !== new URL(base).origin) return null;
    let path = u.pathname;
    if (!path.startsWith("/")) path = "/" + path;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return path;
  } catch {
    return null;
  }
}

// HTML — это без расширения или .html/.htm; ресурсы (img/css/js/etc.) исключаем
function isHtmlPathname(pathname) {
  if (!pathname || pathname === "") return false;
  const m = pathname.match(/\.(\w+)$/i);
  if (!m) return true;
  const ext = m[1].toLowerCase();
  if (ext === "html" || ext === "htm") return true;
  const nonHtml = [
    "jpg",
    "jpeg",
    "png",
    "webp",
    "gif",
    "svg",
    "ico",
    "css",
    "js",
    "mjs",
    "map",
    "json",
    "xml",
    "txt",
    "woff",
    "woff2",
    "ttf",
    "otf",
    "eot",
    "mp4",
    "webm",
    "ogg",
    "mp3",
    "wav",
    "zip",
    "gz",
    "rar",
    "7z",
    "pdf",
    "doc",
    "docx",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
  ];
  return !nonHtml.includes(ext);
}

// Пагинация вида /something/page/2 или ?page=2
function isPaginationPath(pathname, search = "") {
  if (/(^|\/)page\/\d+(\/|$)/i.test(pathname)) return true;
  if (/([?&])page=\d+(\b|&|$)/i.test(search)) return true;
  return false;
}

function isSameOrigin(urlA, urlB) {
  try {
    return new URL(urlA).origin === new URL(urlB).origin;
  } catch {
    return false;
  }
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function normalizeQuotes(value = "") {
  return String(value || "").replace(
    /[\u0022\u0027\u0060\u00ab\u00bb\u201c\u201d\u201e\u201f\u2039\u203a\u201a\u2018\u2019\u201b]/g,
    '"'
  );
}

module.exports = {
  normalizePath,
  isHtmlPathname,
  isPaginationPath,
  isSameOrigin,
  uniq,
  normalizeQuotes,
};
