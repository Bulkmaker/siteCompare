(async () => {
  const res = await fetch("/api/report");
  if (!res.ok) {
    document.body.innerHTML +=
      '<p style="color:#fff;padding:16px">report.json не найден. Запустите npm run crawl.</p>';
    return;
  }

  const rep = await res.json();
  const oldBase = rep.meta.oldBase;
  const newBase = rep.meta.newBase;

  const tbody = document.querySelector("#resultTable tbody");
  const theadCells = Array.from(
    document.querySelectorAll("#resultTable thead th")
  );
  const filterInput = document.getElementById("filterInput");
  const crawlStartBtn = document.getElementById("crawlStartBtn");
  const crawlProgress = document.getElementById("crawlProgress");
  const crawlProgressBar = crawlProgress?.querySelector(".crawl-progress__bar");
  const crawlProgressLabel = crawlProgress?.querySelector(".crawl-progress__label");

  const tglMatchesBtn = document.getElementById("tglMatches");
  const tgl404Btn = document.getElementById("tgl404");
  const tglDiffsBtn = document.getElementById("tglDiffs");
  const tglR301ConsBtn = document.getElementById("tglR301Cons");
  const selCount = document.getElementById("selCount");

  // Считываем отмеченные пути и сохранённые настройки
  const resolvedPaths = JSON.parse(
    localStorage.getItem("resolvedPaths") || "{}"
  );
  const savedToggles = JSON.parse(localStorage.getItem("toggleState") || "{}");
  const savedSort = JSON.parse(localStorage.getItem("sortState") || "{}");

  let crawlPollTimer = null;
  let lastCrawlState = "idle";
  let lastCrawlProgress = 0;

  function setCrawlPolling(enabled) {
    if (enabled) {
      if (!crawlPollTimer) {
        crawlPollTimer = setInterval(() => {
          fetchCrawlStatus().catch(() => {});
        }, 2000);
      }
    } else if (crawlPollTimer) {
      clearInterval(crawlPollTimer);
      crawlPollTimer = null;
    }
  }

  function applyCrawlStatus(status) {
    if (!crawlStartBtn || !crawlProgress || !crawlProgressBar || !crawlProgressLabel)
      return status;
    const state = status?.state || "idle";
    const progressRaw = Number.isFinite(Number(status?.progress))
      ? Number(status?.progress)
      : lastCrawlProgress;
    const progress = Math.max(0, Math.min(100, progressRaw));
    const message = status?.message || "";
    lastCrawlState = state;
    lastCrawlProgress = progress;

    crawlProgress.classList.toggle("crawl-progress--error", state === "error");

    if (state === "idle") {
      crawlProgress.hidden = true;
      crawlProgressBar.style.width = "0%";
      crawlProgressLabel.textContent = "";
      crawlStartBtn.disabled = false;
      setCrawlPolling(false);
      return status;
    }

    crawlProgress.hidden = false;
    crawlProgressBar.style.width = `${progress}%`;
    crawlProgressLabel.textContent = message || `${progress}%`;

    if (state === "error") {
      crawlStartBtn.disabled = false;
      setCrawlPolling(false);
      return status;
    }

    crawlStartBtn.disabled = true;

    if (state !== "idle") setCrawlPolling(true);
    return status;
  }

  function showCrawlWaiting() {
    if (!crawlProgress || !crawlProgressLabel || !crawlStartBtn) return;
    crawlProgress.hidden = false;
    crawlProgressLabel.textContent = "Ожидание сервера...";
    crawlStartBtn.disabled = true;
  }

  async function fetchCrawlStatus() {
    try {
      const res = await fetch("/api/crawl/status", {
        headers: { Accept: "application/json" },
      });
      if (res.status === 404) {
        const fallback = { state: "idle", progress: 0, message: "" };
        applyCrawlStatus(fallback);
        return fallback;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const status = await res.json();
      applyCrawlStatus(status);
      return status;
    } catch (err) {
      if (lastCrawlState && lastCrawlState !== "idle") {
        showCrawlWaiting();
      }
      throw err;
    }
  }

  if (crawlStartBtn) {
    crawlStartBtn.addEventListener("click", async () => {
      applyCrawlStatus({ state: "running", progress: 5, message: "Запуск краулинга" });
      try {
        const resp = await fetch("/api/crawl/start", { method: "POST" });
        const payload = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          applyCrawlStatus({
            state: "error",
            progress: 0,
            message: payload.error || "Не удалось запустить краулинг",
          });
          return;
        }
        applyCrawlStatus(payload);
      } catch (e) {
        applyCrawlStatus({
          state: "error",
          progress: 0,
          message: "Ошибка запуска краулинга",
        });
      }
    });

    fetchCrawlStatus().catch(() => {});
  }

  // Текущее состояние фильтров (тогглов)
  const state = {
    showMatches: savedToggles.showMatches ?? true,
    show404: savedToggles.show404 ?? true,
    showDiffs: savedToggles.showDiffs ?? true,
    showR301Cons: savedToggles.showR301Cons ?? true,
  };

  // Обновляем отображение активности кнопок-тогглов
  function updateToggleButtons() {
    tglMatchesBtn.classList.toggle("active", state.showMatches);
    tgl404Btn.classList.toggle("active", state.show404);
    tglDiffsBtn.classList.toggle("active", state.showDiffs);
    tglR301ConsBtn.classList.toggle("active", state.showR301Cons);
  }
  updateToggleButtons();

  // Подготавливаем данные строк из отчёта
  const ICON_ORDER = {
    bad: 0,
    empty: 1,
    "new-only": 2,
    ok: 3,
  };

  function computeIconState(oldVal, newVal, isMatch) {
    const oldTrim = String(oldVal || "").trim();
    const newTrim = String(newVal || "").trim();
    if (!oldTrim && !newTrim) return "empty";
    if (!oldTrim && newTrim) return "new-only";
    if (isMatch) return "ok";
    return "bad";
  }

  const rows = rep.paths.map((p) => {
    const r = rep.pages[p];
    const oldH1 = r.old.h1 || "";
    const newH1 = r.new.h1 || "";
    const oldTitle = r.old.title || "";
    const newTitle = r.new.title || "";
    const oldDesc = r.old.description || "";
    const newDesc = r.new.description || "";

    const h1State = computeIconState(oldH1, newH1, !!r.diff.h1Match);
    const titleState = computeIconState(oldTitle, newTitle, !!r.diff.titleMatch);
    const descState = computeIconState(oldDesc, newDesc, !!r.diff.descMatch);

    return {
      path: p,
      oldStatus: Number(r.old.status) || 0,
      newStatus: Number(r.new.status) || 0,
      h1Ok: h1State === "ok" || h1State === "empty",
      titleOk: titleState === "ok" || titleState === "empty",
      descOk: descState !== "bad",
      h1State,
      titleState,
      descState,
      oldH1,
      newH1,
      oldTitle,
      newTitle,
      oldDesc,
      newDesc,
      r301DiffPath: !!r.diff.redirectToDifferentPath,
      r301Consolidated: !!r.diff.consolidatedRedirect,
      finalPathNew: r.new.finalPath || p,
    };
  });

  // Описание колонок: чекбокс, путь, статус, H1, Title, Desc
  const headerMap = [
    { key: "resolved", type: "bool" },
    { key: "path", type: "string" },
    { key: "status", type: "number" },
    { key: "h1State", type: "icon" },
    { key: "titleState", type: "icon" },
    { key: "descState", type: "icon" },
  ];

  // Делаем все заголовки сортируемыми
  theadCells.forEach((th) => th.classList.add("sortable"));

  // Состояние сортировки (загружаем сохранённое)
  const sortKeyMap = {
    h1Ok: "h1State",
    titleOk: "titleState",
    descOk: "descState",
  };

  let sortState = {
    key: sortKeyMap[savedSort.key] || savedSort.key || "path",
    dir: savedSort.dir || "asc",
    idx: savedSort.idx ?? 1,
  };

  // Сравнение строк в зависимости от ключа
  function compareRows(a, b, map) {
    switch (map.key) {
      case "resolved": {
        const aRes = resolvedPaths[a.path] ? 1 : 0;
        const bRes = resolvedPaths[b.path] ? 1 : 0;
        return aRes - bRes;
      }
      case "path":
        return a.path.localeCompare(b.path, "ru");
      case "status":
        return a.newStatus - b.newStatus || a.oldStatus - b.oldStatus;
      case "h1State":
      case "titleState":
      case "descState": {
        const orderA = ICON_ORDER[a[map.key]] ?? -1;
        const orderB = ICON_ORDER[b[map.key]] ?? -1;
        return orderA - orderB;
      }
      default:
        return 0;
    }
  }

  // Создаём иконку с данными для tooltip (OLD/NEW)
  function icon(state, oldVal, newVal) {
    const rawOld = String(oldVal || "");
    const rawNew = String(newVal || "");
    const esc = (v) =>
      String(v || "")
        .replace(/"/g, "&quot;")
        .replace(/\n/g, "&#10;");
    if (state === "empty") {
      return `<span class="ico empty" data-old="${esc(rawOld)}" data-new="${esc(
        rawNew
      )}">–</span>`;
    }
    if (state === "new-only") {
      return `<span class="ico new-only" data-old="${esc(rawOld)}" data-new="${esc(
        rawNew
      )}">✓</span>`;
    }
    if (state === "ok") {
      return `<span class="ico ok" data-old="${esc(rawOld)}" data-new="${esc(
        rawNew
      )}">✓</span>`;
    }
    return `<span class="ico bad" data-old="${esc(rawOld)}" data-new="${esc(
      rawNew
    )}">✕</span>`;
  }

  // Фильтр по поиску
  function matchesSearch(row, q) {
    if (!q) return true;
    const s = q.toLowerCase();
    return row.path.toLowerCase().includes(s);
  }

  // Классифицируем строку для фильтрации
  function classify(row) {
    const has404 = row.oldStatus === 404 || row.newStatus === 404;
    const non404Error =
      (row.oldStatus >= 400 && row.oldStatus !== 404) ||
      (row.newStatus >= 400 && row.newStatus !== 404);
    const textDiff = !(row.h1Ok && row.titleOk && row.descOk);
    const isR301Any = row.r301DiffPath || row.r301Consolidated;
    const isMatch = !textDiff && !has404 && !non404Error && !isR301Any;
    const isMismatch = !has404 && !isR301Any && (textDiff || non404Error);
    const isR301Cons = row.r301Consolidated === true;
    return { isMatch, isMismatch, has404, isR301Consolidation: isR301Cons };
  }

  // Обновляем классы сортировки в заголовках
  function renderHeaderClasses() {
    theadCells.forEach((th, i) => {
      th.classList.remove("sort-asc", "sort-desc");
      if (i === sortState.idx) {
        th.classList.add(sortState.dir === "asc" ? "sort-asc" : "sort-desc");
      }
    });
  }

  // Обновляем счётчик выбранных (не отмеченных как решённые)
  function updateSelCount(currentData) {
    if (!selCount) return;
    const unresolvedCount = currentData.filter(
      (row) => !resolvedPaths[row.path]
    ).length;
    selCount.textContent = `Выбрано: ${unresolvedCount}`;
  }

  // Перерисовываем таблицу
  function renderBody() {
    const q = (filterInput?.value || "").trim();
    const map = headerMap[sortState.idx];
    const factor = sortState.dir === "asc" ? 1 : -1;

    // Фильтрация по выбранным категориям и поиску
    const filtered = rows.filter((r) => {
      const { isMatch, isMismatch, has404, isR301Consolidation } = classify(r);
      const pass =
        (state.showMatches && isMatch) ||
        (state.show404 && has404) ||
        (state.showDiffs && isMismatch) ||
        (state.showR301Cons && isR301Consolidation);
      return pass && matchesSearch(r, q);
    });

    // Сортируем
    const data = filtered.sort((a, b) => factor * compareRows(a, b, map));

    // Очищаем тело таблицы
    tbody.innerHTML = "";
    for (const row of data) {
      const tr = document.createElement("tr");
      const newUrl = new URL(row.path, newBase).href;
      const oldUrl = new URL(row.path, oldBase).href;
      const finalUrlNew = new URL(row.finalPathNew, newBase).href;
      const linkTitle = "Клик — NEW, Ctrl/Cmd+клик — OLD";

      // Создаём иконки
      const h1Icon = icon(row.h1State, row.oldH1, row.newH1);
      const titleIcon = icon(row.titleState, row.oldTitle, row.newTitle);
      const descIcon = icon(row.descState, row.oldDesc, row.newDesc);

      // Плашка 301, если требуется
      const pill = row.r301DiffPath
        ? ` <span class="pill" title="Редирект 301 на другой путь"><a href="${finalUrlNew}" target="_blank" rel="noopener">301→ ${row.finalPathNew}</a></span>`
        : "";

      const isResolved = !!resolvedPaths[row.path];
      tr.classList.toggle("resolved", isResolved);

      // Формируем HTML строки, включая кнопку обновления
      tr.innerHTML = `
        <td><input type="checkbox" class="resolve-checkbox" data-path="${
          row.path
        }" ${isResolved ? "checked" : ""}></td>
        <td><a class="path-link" href="${newUrl}" target="_blank" rel="noopener" title="${linkTitle}">${
        row.path
      }</a></td>
        <td class="mono">${row.oldStatus} → ${row.newStatus}${pill}</td>
        <td>${h1Icon}</td>
        <td>${titleIcon}</td>
        <td>${descIcon}</td>
        <td><button class="refresh-btn" data-path="${
          row.path
        }" title="Обновить запись">↻</button></td>
      `;

      // Чекбокс «решено»
      const checkbox = tr.querySelector(".resolve-checkbox");
      checkbox.addEventListener("click", (e) => {
        e.stopPropagation();
        const path = e.target.dataset.path;
        const checked = e.target.checked;
        resolvedPaths[path] = checked;
        if (!checked) delete resolvedPaths[path];
        localStorage.setItem("resolvedPaths", JSON.stringify(resolvedPaths));
        tr.classList.toggle("resolved", checked);
        updateSelCount(data);
      });

      // Поведение Ctrl/⌘+клик по ссылке
      const a = tr.querySelector(".path-link");
      a.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          window.open(oldUrl, "_blank", "noopener");
        }
      });

      // Кнопка обновления строки
      const refreshBtn = tr.querySelector(".refresh-btn");
      refreshBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const path = e.target.dataset.path;
        // Запрос к серверу
        const resp = await fetch(
          `/api/refresh?path=${encodeURIComponent(path)}`
        );
        if (resp.ok) {
          const json = await resp.json();
          const updated = json.data;
          // Ищем и обновляем данные в массиве rows
          const idx = rows.findIndex((r) => r.path === path);
          if (idx !== -1) {
            rows[idx].oldStatus = updated.old.status;
            rows[idx].newStatus = updated.new.status;
            rows[idx].h1Ok = updated.diff.h1Match;
            rows[idx].titleOk = updated.diff.titleMatch;
            rows[idx].descOk = updated.diff.descMatch;
            rows[idx].oldH1 = updated.old.h1 || "";
            rows[idx].newH1 = updated.new.h1 || "";
            rows[idx].oldTitle = updated.old.title || "";
            rows[idx].newTitle = updated.new.title || "";
            rows[idx].oldDesc = updated.old.description || "";
            rows[idx].newDesc = updated.new.description || "";
            // Перерисовываем таблицу
            renderBody();
          }
        } else {
          alert("Ошибка обновления строки");
        }
      });

      // Добавляем строку в таблицу
      tbody.appendChild(tr);
    }

    // Обновляем счётчик
    updateSelCount(data);
  }

  // Клик по заголовку — сортировка
  theadCells.forEach((th, i) => {
    th.addEventListener("click", () => {
      const keyObj = headerMap[i];
      if (!keyObj || !keyObj.key) return;
      if (sortState.idx === i) {
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState.idx = i;
        sortState.key = keyObj.key;
        sortState.dir = "asc";
      }
      localStorage.setItem("sortState", JSON.stringify(sortState));
      renderHeaderClasses();
      renderBody();
    });
  });

  // Фильтр по поиску
  if (filterInput) filterInput.addEventListener("input", renderBody);

  // Привязка тогглов с сохранением состояния
  function bindChip(btn, key) {
    if (!btn) return;
    btn.addEventListener("click", () => {
      state[key] = !state[key];
      btn.classList.toggle("active", state[key]);
      localStorage.setItem("toggleState", JSON.stringify(state));
      renderBody();
    });
    btn.classList.toggle("active", state[key]);
  }
  bindChip(tglMatchesBtn, "showMatches");
  bindChip(tgl404Btn, "show404");
  bindChip(tglDiffsBtn, "showDiffs");
  bindChip(tglR301ConsBtn, "showR301Cons");

  // Инициализация таблицы
  renderHeaderClasses();
  renderBody();
})();
