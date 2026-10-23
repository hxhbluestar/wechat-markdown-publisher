/**
 * AMD ROCm Lab · 本地内容归档
 * 原生 SPA：分页、全文检索、三类文章模板、灯箱、媒体控制和阅读偏好。
 */

const S = {
  stats: null,
  route: { name: "home", params: new URLSearchParams() },
  requestToken: 0,
  lightboxItems: [],
  lightboxIndex: 0,
  searchItems: [],
  searchIndex: -1,
  searchTimer: null,
  galleryArticle: null,
  galleryVisible: 24,
  currentMedia: null,
  headingObserver: null,
  masonryObserver: null,
  themeMode: localStorage.getItem("theme-mode") || "system",
  fontSize: Math.min(21, Math.max(15, Number(localStorage.getItem("reader-font")) || 17)),
  saveScrollTimer: null,
  lightboxTouchX: null,
  focusArticleSearch: false,
};

const E = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  Object.assign(E, {
    root: document.getElementById("pageRoot"),
    scroller: document.getElementById("mainScroll"),
    sidebar: document.getElementById("sidebar"),
    scrim: document.getElementById("sidebarScrim"),
    menu: document.getElementById("menuButton"),
    nav: document.getElementById("primaryNav"),
    pageTitle: document.getElementById("pageTitle"),
    pageKicker: document.getElementById("pageKicker"),
    progress: document.getElementById("readingProgress"),
    searchTrigger: document.getElementById("searchTrigger"),
    searchDialog: document.getElementById("searchDialog"),
    searchInput: document.getElementById("searchInput"),
    searchResults: document.getElementById("searchResults"),
    searchClose: document.getElementById("searchClose"),
    lightbox: document.getElementById("lightboxDialog"),
    lightboxImage: document.getElementById("lightboxImage"),
    lightboxCaption: document.getElementById("lightboxCaption"),
    lightboxCounter: document.getElementById("lightboxCounter"),
    lightboxDownload: document.getElementById("lightboxDownload"),
    lightboxPrev: document.getElementById("lightboxPrev"),
    lightboxNext: document.getElementById("lightboxNext"),
    lightboxClose: document.getElementById("lightboxClose"),
    themeButton: document.getElementById("themeButton"),
    themeIcon: document.getElementById("themeIcon"),
    themeLabel: document.getElementById("themeLabel"),
    fontStepper: document.getElementById("fontStepper"),
    fontValue: document.getElementById("fontValue"),
    fontDown: document.getElementById("fontDown"),
    fontUp: document.getElementById("fontUp"),
    toast: document.getElementById("toastRegion"),
  });

  bindGlobalEvents();
  applyTheme();
  applyFontSize();
  await loadStats();
  if (!location.hash) {
    location.replace("#/home");
  } else {
    routeFromHash();
  }
}

function bindGlobalEvents() {
  window.addEventListener("hashchange", routeFromHash);
  document.addEventListener("click", handleClick);
  document.addEventListener("input", handleInput);
  document.addEventListener("change", handleChange);
  document.addEventListener("keydown", handleKeydown);
  E.scroller.addEventListener("scroll", handleScroll, { passive: true });

  E.menu.addEventListener("click", openSidebar);
  E.scrim.addEventListener("click", closeSidebar);
  E.searchTrigger.addEventListener("click", openSearch);
  E.searchClose.addEventListener("click", closeSearch);
  E.searchInput.addEventListener("input", scheduleSearch);
  E.searchDialog.addEventListener("click", (event) => {
    if (event.target === E.searchDialog) closeSearch();
  });

  E.lightboxClose.addEventListener("click", closeLightbox);
  E.lightboxPrev.addEventListener("click", () => moveLightbox(-1));
  E.lightboxNext.addEventListener("click", () => moveLightbox(1));
  E.lightbox.addEventListener("click", (event) => {
    if (event.target === E.lightbox) closeLightbox();
  });
  E.lightbox.addEventListener("touchstart", (event) => {
    S.lightboxTouchX = event.changedTouches[0]?.clientX ?? null;
  }, { passive: true });
  E.lightbox.addEventListener("touchend", (event) => {
    if (S.lightboxTouchX === null) return;
    const distance = (event.changedTouches[0]?.clientX ?? S.lightboxTouchX) - S.lightboxTouchX;
    S.lightboxTouchX = null;
    if (Math.abs(distance) > 52) moveLightbox(distance > 0 ? -1 : 1);
  }, { passive: true });
  E.lightbox.addEventListener("close", () => {
    E.lightboxImage.src = "";
  });

  E.themeButton.addEventListener("click", cycleTheme);
  E.fontDown.addEventListener("click", () => setFontSize(S.fontSize - 1));
  E.fontUp.addEventListener("click", () => setFontSize(S.fontSize + 1));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (S.themeMode === "system") applyTheme();
  });
}

async function loadStats() {
  try {
    S.stats = await fetchJSON("/api/stats");
    document.getElementById("articleCount").textContent = S.stats.articles;
    document.getElementById("imageCount").textContent = compactNumber(S.stats.images);
    document.getElementById("audioCount").textContent = S.stats.audio;
    document.getElementById("videoCount").textContent = S.stats.video;
  } catch (error) {
    showToast("本地归档读取失败");
  }
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path = "home", query = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  return {
    name: parts[0] || "home",
    id: parts[1] || "",
    params: new URLSearchParams(query),
  };
}

function routeFromHash() {
  const next = parseHash();
  S.route = next;
  closeSidebar();
  closeSearch();
  stopObservers();
  E.scroller.scrollTop = 0;
  E.progress.value = 0;
  E.fontStepper.classList.toggle("is-visible", next.name === "article");
  updateChrome(next);
  renderRoute(next);
}

function updateChrome(route) {
  const titles = {
    home: ["本地内容归档", "总览"],
    articles: ["文章时间线", "全部文章"],
    article: ["沉浸阅读", "文章详情"],
    images: ["本地媒体库", "图片"],
    audio: ["本地媒体库", "音频"],
    videos: ["本地媒体库", "视频"],
  };
  const [kicker, title] = titles[route.name] || titles.home;
  E.pageKicker.textContent = kicker;
  E.pageTitle.textContent = title;
  document.title = `${title} · AMD ROCm Lab`;
  document.querySelectorAll("[data-route]").forEach((button) => {
    const target = button.dataset.route;
    const active =
      target === route.name ||
      (route.name === "article" && target === "articles");
    button.classList.toggle("is-active", active);
  });
}

async function renderRoute(route) {
  const token = ++S.requestToken;
  renderLoading();
  try {
    if (route.name === "home") await renderHome(token);
    else if (route.name === "articles") await renderArticles(token);
    else if (route.name === "article") await renderArticle(route.id, token);
    else if (route.name === "images") await renderMediaLibrary("image", token);
    else if (route.name === "audio") await renderMediaLibrary("audio", token);
    else if (route.name === "videos") await renderMediaLibrary("video", token);
    else location.hash = "#/home";
  } catch (error) {
    if (token !== S.requestToken) return;
    renderError(error.message || "页面加载失败");
  }
}

function renderLoading() {
  E.root.innerHTML = `
    <div class="page-loading">
      <span class="loading-mark"></span>
      <p>正在整理本地记忆…</p>
    </div>`;
}

function renderError(message) {
  E.root.innerHTML = `
    <div class="empty-state">
      <span class="empty-symbol">!</span>
      <h2>暂时无法打开</h2>
      <p>${esc(message)}</p>
      <button class="primary-button" type="button" data-action="retry">重新加载</button>
    </div>`;
}

async function renderHome(token) {
  const data = await fetchJSON("/api/articles?page=1&page_size=7");
  if (token !== S.requestToken) return;
  const stats = S.stats || data.facets;
  const recent = data.items;
  const hero = recent[0];
  const gallery = recent.slice(1, 5);
  E.root.innerHTML = `
    <section class="home-page">
      <div class="home-hero">
        <div class="hero-copy">
          <span class="hero-eyebrow"><i></i> 纯本地 · 随时可读</span>
          <h2>把写过的日子，<br>重新放回手边。</h2>
          <p>从 2021 到 2026，文字、照片与声音都安静地留在这里。无需联网，慢慢翻，随时重遇。</p>
          <div class="hero-actions">
            <button class="primary-button" type="button" data-route="articles">开始翻阅 <span>→</span></button>
            <button class="secondary-button" type="button" data-action="open-search">搜索记忆</button>
          </div>
        </div>
        <div class="hero-covers" aria-label="最近文章封面">
          ${gallery.map((item, index) => `
            <button type="button" class="hero-cover cover-${index + 1}" data-article-id="${item.id}" aria-label="打开${esc(item.title)}">
              ${coverImage(item, "hero-cover-image")}
              <span>${esc(item.date.slice(0, 10))}</span>
            </button>`).join("")}
        </div>
      </div>

      <div class="stat-ribbon">
        ${statBlock(stats.articles, "篇文章", "articles")}
        ${statBlock(stats.images, "张图片", "images")}
        ${statBlock(stats.audio + stats.video, "段声音与影像", "articles?type=media")}
        ${statBlock(Object.keys(stats.years || {}).length, "个年份", "articles")}
      </div>

      <section class="section-block">
        <div class="section-heading">
          <div><span class="section-kicker">LATEST</span><h2>最近归档</h2></div>
          <button class="text-button" type="button" data-route="articles">查看全部 <span>→</span></button>
        </div>
        <div class="feature-grid">
          ${hero ? featureCard(hero) : ""}
          <div class="recent-stack">
            ${recent.slice(1, 5).map(compactArticleRow).join("")}
          </div>
        </div>
      </section>

      <section class="memory-strip">
        <div>
          <span class="section-kicker">BROWSE BY MOOD</span>
          <h2>换一种方式重逢</h2>
        </div>
        <div class="memory-actions">
          <button type="button" data-href="#/articles?type=normal"><span>文</span><strong>读一篇旧文</strong><small>${stats.types.normal} 篇</small></button>
          <button type="button" data-href="#/articles?type=gallery"><span>图</span><strong>看一组照片</strong><small>${stats.types.gallery} 篇</small></button>
          <button type="button" data-href="#/articles?type=media"><span>声</span><strong>听一段声音</strong><small>${stats.types.media} 篇</small></button>
        </div>
      </section>
    </section>`;
}

function statBlock(value, label, route) {
  return `
    <button type="button" class="stat-block" data-href="#/${route}">
      <strong>${compactNumber(value)}</strong><span>${label}</span>
    </button>`;
}

function featureCard(article) {
  return `
    <button class="feature-card" type="button" data-article-id="${article.id}">
      <div class="feature-cover">${coverImage(article, "")}</div>
      <div class="feature-copy">
        ${typeBadge(article)}
        <h3>${esc(article.title)}</h3>
        <p>${esc(article.summary)}</p>
        <span class="date-line">${formatDate(article.date)} <i></i> ${articleMeta(article)}</span>
      </div>
    </button>`;
}

function compactArticleRow(article) {
  return `
    <button class="compact-row" type="button" data-article-id="${article.id}">
      <span class="compact-date"><strong>${article.date.slice(5, 7)}</strong><small>${article.date.slice(8, 10)}</small></span>
      <span class="compact-copy">
        <strong>${esc(article.title)}</strong>
        <small>${esc(article.summary)}</small>
      </span>
      <span class="row-arrow">→</span>
    </button>`;
}

async function renderArticles(token) {
  const p = S.route.params;
  const page = clamp(Number(p.get("page")) || 1, 1, 999);
  const year = p.get("year") || "all";
  const type = p.get("type") || "all";
  const q = p.get("q") || "";
  const sort = p.get("sort") || "date_desc";
  const url = `/api/articles?${new URLSearchParams({
    page: String(page),
    page_size: "24",
    year,
    type,
    q,
    sort,
  })}`;
  const data = await fetchJSON(url);
  if (token !== S.requestToken) return;
  const years = Object.entries(data.facets.years || {});
  E.root.innerHTML = `
    <section class="archive-page">
      <header class="archive-intro">
        <div>
          <span class="section-kicker">ARCHIVE</span>
          <h2>沿着时间，慢慢翻阅</h2>
          <p>共 ${data.total} 篇符合条件的文章，每页 24 篇。</p>
        </div>
        <label class="inline-search">
          <span>⌕</span>
          <input id="articleSearch" type="search" value="${attr(q)}" placeholder="在标题与正文中检索">
        </label>
      </header>

      <div class="filter-section">
        <div class="filter-row">
          <span class="filter-label">类型</span>
          ${filterChip("type", "all", "全部", type)}
          ${filterChip("type", "normal", `图文 ${data.facets.types.normal}`, type)}
          ${filterChip("type", "gallery", `图集 ${data.facets.types.gallery}`, type)}
          ${filterChip("type", "media", `音视频 ${data.facets.types.media}`, type)}
        </div>
        <div class="filter-row year-row">
          <span class="filter-label">年份</span>
          ${filterChip("year", "all", "全部", year)}
          ${years.map(([value, count]) => filterChip("year", value, `${value} ${count}`, year)).join("")}
          <label class="sort-select">
            <span>排序</span>
            <select id="articleSort">
              <option value="date_desc" ${sort === "date_desc" ? "selected" : ""}>从新到旧</option>
              <option value="date_asc" ${sort === "date_asc" ? "selected" : ""}>从旧到新</option>
              <option value="title" ${sort === "title" ? "selected" : ""}>按标题</option>
            </select>
          </label>
        </div>
      </div>

      ${data.items.length ? `
        <div class="article-grid">
          ${data.items.map(articleCard).join("")}
        </div>
        ${pagination(data)}
      ` : `
        <div class="empty-state">
          <span class="empty-symbol">○</span>
          <h2>没有找到相符的文章</h2>
          <p>换一个关键词，或清除部分筛选条件。</p>
          <button type="button" class="secondary-button" data-action="clear-filters">清除筛选</button>
        </div>`}
    </section>`;
  if (S.focusArticleSearch) {
    S.focusArticleSearch = false;
    requestAnimationFrame(() => {
      const input = document.getElementById("articleSearch");
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    });
  }
}

function filterChip(key, value, label, current) {
  return `<button type="button" class="filter-chip ${value === current ? "is-active" : ""}" data-filter-key="${key}" data-filter-value="${value}">${esc(label)}</button>`;
}

function articleCard(article) {
  return `
    <article class="article-card ${article.type}">
      <button class="article-card-hit" type="button" data-article-id="${article.id}" aria-label="打开${attr(article.title)}"></button>
      <div class="card-cover">
        ${coverImage(article, "")}
        <span class="card-year">${esc(article.year)}</span>
      </div>
      <div class="card-body">
        <div class="card-topline">${typeBadge(article)}<time>${formatDate(article.date)}</time></div>
        <h3>${esc(article.title)}</h3>
        <p>${esc(article.summary)}</p>
        <div class="card-footer"><span>${articleMeta(article)}</span><span>阅读全文 →</span></div>
      </div>
    </article>`;
}

function pagination(data) {
  if (data.total_pages <= 1) return "";
  const pages = pageWindow(data.page, data.total_pages);
  return `
    <nav class="pagination" aria-label="文章分页">
      <button type="button" data-page="${data.page - 1}" ${data.page <= 1 ? "disabled" : ""}>← 上一页</button>
      <div>
        ${pages.map((page) => page === "…" ? `<span>…</span>` : `<button type="button" class="${page === data.page ? "is-active" : ""}" data-page="${page}" ${page === data.page ? 'aria-current="page"' : ""}>${page}</button>`).join("")}
      </div>
      <button type="button" data-page="${data.page + 1}" ${data.page >= data.total_pages ? "disabled" : ""}>下一页 →</button>
    </nav>`;
}

async function renderArticle(articleId, token) {
  if (!articleId) throw new Error("缺少文章标识");
  const article = await fetchJSON(`/api/article/${encodeURIComponent(articleId)}`);
  if (token !== S.requestToken) return;
  S.galleryArticle = article;
  S.galleryVisible = 24;
  E.pageTitle.textContent = article.title;
  document.title = `${article.title} · AMD ROCm Lab`;
  const galleryBefore = article.type === "gallery";
  const media = mediaSection(article);
  const gallery = articleGallery(article, galleryBefore ? "gallery" : "appendix");
  const mobileToc = article.headings.length ? `
    <details class="mobile-toc">
      <summary>文章目录 <span>${article.headings.length} 节</span></summary>
      ${tocList(article.headings)}
    </details>` : "";

  E.root.innerHTML = `
    <article class="reader-page type-${article.type}">
      <div class="reader-topline">
        <button class="back-button" type="button" data-action="back-to-articles">← 返回文章列表</button>
        <span>${esc(article.type_label)} · ${article.image_count ? `${article.image_count} 图` : "纯文字"}${article.audio_count ? ` · ${article.audio_count} 音频` : ""}${article.video_count ? ` · ${article.video_count} 视频` : ""}</span>
      </div>

      <div class="reader-layout">
        <aside class="reader-toc">
          <div class="sticky-card">
            <span class="toc-title">目录</span>
            ${article.headings.length ? tocList(article.headings) : `<p class="toc-empty">这篇文章没有章节标题</p>`}
          </div>
        </aside>

        <main class="article-paper" id="articlePaper">
          <header class="article-header">
            ${typeBadge(article)}
            <h1>${esc(article.title)}</h1>
            <p class="article-deck">${esc(article.summary)}</p>
            <div class="article-byline">
              <time>${formatDateLong(article.date)}</time>
              <span>·</span><span>${readingTime(article)}</span>
              ${article.url ? `<span>·</span><a href="${attr(article.url)}" target="_blank" rel="noopener noreferrer" title="需要联网">微信原文 ↗</a>` : ""}
            </div>
          </header>

          ${mobileToc}
          ${galleryBefore ? gallery : ""}
          ${article.type === "media" ? media : ""}

          <div class="md-content" id="articleContent">${article.content_html}</div>

          ${!galleryBefore ? gallery : ""}
          ${article.type !== "media" ? media : ""}
          ${renderWarnings(article.warnings)}
          ${neighborNavigation(article.neighbors)}
        </main>

        <aside class="reader-tools" aria-label="阅读工具">
          <div class="sticky-tools">
            <button type="button" data-action="scroll-top" aria-label="回到文章顶部">↑<span>顶部</span></button>
            <button type="button" data-action="open-search" aria-label="搜索归档">⌕<span>搜索</span></button>
            <button type="button" data-action="cycle-theme" aria-label="切换主题">◐<span>主题</span></button>
          </div>
        </aside>
      </div>
    </article>`;

  afterArticleRender(article);
}

function tocList(headings) {
  return `
    <nav class="toc-list" aria-label="文章目录">
      ${headings.map((heading) => `<a href="#${attr(heading.id)}" data-heading-id="${attr(heading.id)}" class="level-${heading.level}">${esc(heading.text)}</a>`).join("")}
    </nav>`;
}

function articleGallery(article, mode) {
  if (!article.images.length) return "";
  const visible = article.images.slice(0, S.galleryVisible);
  return `
    <section class="article-gallery ${mode}" id="articleGallery">
      <div class="gallery-heading">
        <div><span class="section-kicker">${mode === "gallery" ? "PHOTO STORY" : "IMAGES"}</span><h2>${mode === "gallery" ? "图像记忆" : "本文附图"}</h2></div>
        <span>${article.images.length} 张</span>
      </div>
      <div class="photo-grid ${article.images.length === 1 ? "single-image" : ""}">
        ${visible.map((image, index) => galleryTile(image, index)).join("")}
      </div>
      ${visible.length < article.images.length ? `<button type="button" class="load-more" data-action="load-gallery">继续展开 ${Math.min(24, article.images.length - visible.length)} 张 <span>↓</span></button>` : ""}
    </section>`;
}

function galleryTile(image, index) {
  const hasDimensions = Boolean(image.width && image.height);
  const ratio = hasDimensions ? image.width / image.height : 1;
  const shape = ratio > 1.55 ? "wide" : ratio < 0.72 ? "tall" : "standard";
  return `
    <button type="button" class="photo-tile ${shape}" data-gallery-index="${index}" ${hasDimensions ? `data-ratio="${ratio.toFixed(6)}"` : ""} aria-label="查看第 ${index + 1} 张图片">
      <img src="${attr(image.url)}" alt="" loading="lazy" decoding="async" ${hasDimensions ? `width="${image.width}" height="${image.height}"` : ""}>
      <span>${String(index + 1).padStart(2, "0")}</span>
    </button>`;
}

function mediaSection(article) {
  const items = [...article.video, ...article.audio];
  if (!items.length) return "";
  return `
    <section class="article-media">
      <div class="gallery-heading">
        <div><span class="section-kicker">LOCAL MEDIA</span><h2>声音与影像</h2></div>
        <span>${items.length} 个本地媒体</span>
      </div>
      <div class="media-player-list">
        ${items.map((item, index) => mediaPlayer(item, article, index)).join("")}
      </div>
    </section>`;
}

function mediaPlayer(item, article, index) {
  const isVideo = item.kind === "video";
  const mediaTag = isVideo
    ? `<video preload="metadata" playsinline src="${attr(item.url)}" ${article.cover ? `poster="${attr(article.cover)}"` : ""}></video>`
    : `<audio preload="metadata" src="${attr(item.url)}"></audio>`;
  return `
    <div class="media-player ${item.kind}" data-media-id="${item.id}" data-storage-key="media-progress:${article.id}:${item.id}">
      ${isVideo ? `<div class="video-stage">${mediaTag}<button type="button" class="video-center-play" data-action="media-toggle" aria-label="播放视频">▶</button></div>` : mediaTag}
      <div class="media-info">
        <span class="media-index">${isVideo ? "影" : "声"} ${String(index + 1).padStart(2, "0")}</span>
        <div><strong>${esc(article.title)}</strong><small>${esc(item.name)} · ${formatBytes(item.size)}</small></div>
      </div>
      <div class="media-controls">
        <button type="button" class="media-play" data-action="media-toggle" aria-label="播放">▶</button>
        <span class="media-time current">0:00</span>
        <input class="media-seek" type="range" min="0" max="1000" value="0" aria-label="播放进度">
        <span class="media-time duration">0:00</span>
        <button type="button" class="media-mute" data-action="media-mute" aria-label="静音">⌁</button>
        <input class="media-volume" type="range" min="0" max="1" step="0.05" value="1" aria-label="音量">
        <select class="media-rate" aria-label="播放速度">
          <option value="0.75">0.75×</option><option value="1" selected>1×</option>
          <option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option>
        </select>
        ${isVideo ? `<button type="button" class="media-fullscreen" data-action="media-fullscreen" aria-label="全屏">⛶</button>` : ""}
      </div>
    </div>`;
}

function renderWarnings(warnings) {
  if (!warnings.length) return "";
  return `
    <details class="archive-notes">
      <summary>归档说明 <span>${warnings.length}</span></summary>
      <ul>${warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>
    </details>`;
}

function neighborNavigation(neighbors) {
  return `
    <nav class="article-neighbors" aria-label="相邻文章">
      ${neighbors.newer ? `<button type="button" data-article-id="${neighbors.newer.id}"><small>更新一篇</small><strong>← ${esc(neighbors.newer.title)}</strong></button>` : `<span></span>`}
      ${neighbors.older ? `<button type="button" data-article-id="${neighbors.older.id}"><small>更早一篇</small><strong>${esc(neighbors.older.title)} →</strong></button>` : `<span></span>`}
    </nav>`;
}

function afterArticleRender(article) {
  if (window.hljs) {
    if (!window.hljs.getLanguage("powershell") && window.hljs.getLanguage("shell")) {
      window.hljs.registerAliases(["powershell", "ps1"], { languageName: "shell" });
    }
    document.querySelectorAll("pre code").forEach((block) => window.hljs.highlightElement(block));
  }
  enhanceCodeBlocks();
  document.querySelectorAll(".md-content img").forEach((image) => {
    image.tabIndex = 0;
    image.setAttribute("role", "button");
    image.setAttribute("aria-label", image.alt ? `查看图片：${image.alt}` : "查看大图");
  });
  initMasonryGalleries();
  initMediaPlayers();
  initHeadingObserver();
  const saved = Number(sessionStorage.getItem(`reading-scroll:${article.id}`)) || 0;
  requestAnimationFrame(() => {
    E.scroller.scrollTop = Math.min(saved, Math.max(0, E.scroller.scrollHeight - E.scroller.clientHeight));
    updateReadingProgress();
  });
}

function initMasonryGalleries() {
  if (typeof ResizeObserver !== "function") return;
  if (!S.masonryObserver) {
    S.masonryObserver = new ResizeObserver((entries) => {
      entries.forEach((entry) => layoutMasonryGrid(entry.target));
    });
  }

  document.querySelectorAll(".article-gallery.gallery .photo-grid:not(.single-image)").forEach((grid) => {
    grid.classList.add("is-masonry");
    S.masonryObserver.observe(grid);
    grid.querySelectorAll("img").forEach((image) => {
      if (image.complete || image.dataset.masonryBound) return;
      image.dataset.masonryBound = "true";
      image.addEventListener("load", () => layoutMasonryGrid(grid), { once: true });
    });
    requestAnimationFrame(() => layoutMasonryGrid(grid));
  });
}

function layoutMasonryGrid(grid) {
  if (!grid?.isConnected) return;
  const width = grid.clientWidth;
  if (!width) return;

  const columns = width < 380 ? 1 : 2;
  const gap = columns === 1 ? 10 : 14;
  const columnWidth = (width - gap * (columns - 1)) / columns;
  const columnHeights = Array(columns).fill(0);

  grid.querySelectorAll(".photo-tile").forEach((tile) => {
    const image = tile.querySelector("img");
    const storedRatio = Number(tile.dataset.ratio);
    const naturalRatio = image?.naturalWidth && image?.naturalHeight ? image.naturalWidth / image.naturalHeight : 0;
    const ratio = storedRatio > 0 ? storedRatio : naturalRatio > 0 ? naturalRatio : 1;
    const column = columnHeights.indexOf(Math.min(...columnHeights));
    const tileHeight = columnWidth / Math.min(20, Math.max(.05, ratio));
    const x = column * (columnWidth + gap);
    const y = columnHeights[column];

    tile.style.width = `${columnWidth}px`;
    tile.style.height = `${tileHeight}px`;
    tile.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    columnHeights[column] += tileHeight + gap;
  });

  grid.style.height = `${Math.max(0, Math.max(...columnHeights) - gap)}px`;
  grid.classList.add("is-ready");
}

function enhanceCodeBlocks() {
  const languageNames = {
    powershell: "PowerShell",
    json: "JSON",
    text: "纯文本",
    plaintext: "纯文本",
  };
  let wrapByDefault = false;
  try {
    wrapByDefault = localStorage.getItem("code-wrap") === "true";
  } catch {}

  document.querySelectorAll(".md-content pre").forEach((pre, index) => {
    const code = pre.querySelector("code");
    if (!code || !code.textContent.trim() || pre.closest(".code-shell")) return;
    const languageClass = [...code.classList].find((name) => name.startsWith("language-"));
    const language = languageClass?.slice(9) || code.dataset.highlighted && code.className.match(/\b(?:json|powershell)\b/)?.[0] || "text";

    const shell = document.createElement("section");
    shell.className = `code-shell${wrapByDefault ? " is-wrapped" : ""}`;
    shell.setAttribute("aria-label", `代码块 ${index + 1}`);
    const toolbar = document.createElement("div");
    toolbar.className = "code-toolbar";
    const label = document.createElement("span");
    label.className = "code-language";
    label.textContent = languageNames[language] || language.toUpperCase();
    const actions = document.createElement("div");
    actions.className = "code-actions";

    const wrapButton = document.createElement("button");
    wrapButton.type = "button";
    wrapButton.className = "code-action";
    wrapButton.dataset.action = "toggle-code-wrap";
    wrapButton.setAttribute("aria-pressed", String(wrapByDefault));
    wrapButton.textContent = wrapByDefault ? "不换行" : "自动换行";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "code-action copy-code";
    copyButton.dataset.action = "copy-code";
    copyButton.textContent = "复制";

    actions.append(wrapButton, copyButton);
    toolbar.append(label, actions);
    pre.before(shell);
    shell.append(toolbar, pre);
  });
}

function copyCodeBlock(button) {
  const code = button.closest(".code-shell")?.querySelector("code")?.textContent || "";
  if (!code) return;
  const complete = () => {
    button.classList.add("is-copied");
    button.textContent = "已复制 ✓";
    showToast("代码已复制");
    setTimeout(() => {
      button.classList.remove("is-copied");
      button.textContent = "复制";
    }, 1600);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(code).then(complete).catch(() => fallbackCopy(code, complete));
  } else {
    fallbackCopy(code, complete);
  }
}

function fallbackCopy(value, complete) {
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (copied) complete();
  else showToast("复制失败，请手动选择代码");
}

function toggleCodeWrap(button) {
  const shell = button.closest(".code-shell");
  if (!shell) return;
  const wrapped = shell.classList.toggle("is-wrapped");
  button.setAttribute("aria-pressed", String(wrapped));
  button.textContent = wrapped ? "不换行" : "自动换行";
  try {
    localStorage.setItem("code-wrap", String(wrapped));
  } catch {}
}

async function renderMediaLibrary(kind, token) {
  const page = clamp(Number(S.route.params.get("page")) || 1, 1, 999);
  const year = S.route.params.get("year") || "all";
  const pageSize = kind === "image" ? 48 : 24;
  const data = await fetchJSON(`/api/media?${new URLSearchParams({ kind, page: String(page), page_size: String(pageSize), year })}`);
  if (token !== S.requestToken) return;
  const labels = { image: ["图片", "每一张照片，都是时间留下的证词。"], audio: ["音频", "重新听见当时的语气与呼吸。"], video: ["视频", "让那些会动的片段，再播放一次。"] };
  const [title, description] = labels[kind];
  if (kind === "image") S.lightboxItems = data.items;
  E.root.innerHTML = `
    <section class="media-library">
      <header class="archive-intro">
        <div><span class="section-kicker">LOCAL MEDIA</span><h2>${title}</h2><p>${description} 共 ${data.total} 个本地文件。</p></div>
        <label class="media-year-select">年份
          <select id="mediaYear">
            <option value="all">全部年份</option>
            ${Object.keys(S.stats?.years || {}).map((value) => `<option value="${value}" ${value === year ? "selected" : ""}>${value}</option>`).join("")}
          </select>
        </label>
      </header>
      ${data.items.length ? kind === "image" ? `
        <div class="library-photo-grid">
          ${data.items.map((item, index) => `
            <button type="button" class="library-photo" data-library-image="${index}">
              <img src="${attr(item.url)}" alt="" loading="lazy" decoding="async" ${item.width ? `width="${item.width}" height="${item.height}"` : ""}>
              <span><strong>${esc(item.article_title)}</strong><small>${item.year} · ${esc(item.name)}</small></span>
            </button>`).join("")}
        </div>` : `
        <div class="media-library-list">
          ${data.items.map((item, index) => mediaPlayer(item, { id: item.article_id, title: item.article_title, cover: "" }, index)).join("")}
        </div>` : `<div class="empty-state"><span class="empty-symbol">○</span><h2>暂无${title}</h2></div>`}
      ${pagination(data)}
    </section>`;
  if (kind !== "image") initMediaPlayers();
}

function initMediaPlayers() {
  document.querySelectorAll(".media-player").forEach((player) => {
    const media = player.querySelector("audio, video");
    if (!media || media.dataset.ready === "1") return;
    media.dataset.ready = "1";
    const update = () => updateMediaUI(player, media);
    media.addEventListener("loadedmetadata", () => {
      const saved = JSON.parse(localStorage.getItem(player.dataset.storageKey) || "{}");
      if (saved.time && saved.time < media.duration * 0.95) media.currentTime = saved.time;
      if (saved.rate) media.playbackRate = saved.rate;
      if (saved.volume !== undefined) media.volume = saved.volume;
      player.querySelector(".media-rate").value = String(media.playbackRate);
      player.querySelector(".media-volume").value = String(media.volume);
      update();
    });
    media.addEventListener("timeupdate", () => {
      update();
      const second = Math.floor(media.currentTime);
      if (second % 5 === 0 && player.dataset.lastSavedSecond !== String(second)) {
        player.dataset.lastSavedSecond = String(second);
        saveMediaProgress(player, media);
      }
    });
    media.addEventListener("play", () => {
      if (S.currentMedia && S.currentMedia !== media) S.currentMedia.pause();
      S.currentMedia = media;
      player.classList.add("is-playing");
      update();
    });
    media.addEventListener("pause", () => {
      player.classList.remove("is-playing");
      saveMediaProgress(player, media);
      update();
    });
    media.addEventListener("ended", () => {
      localStorage.removeItem(player.dataset.storageKey);
      player.classList.remove("is-playing");
      update();
    });
    media.addEventListener("error", () => {
      player.classList.add("has-error");
      showToast("这个本地媒体暂时无法播放");
    });
  });
}

function updateMediaUI(player, media) {
  const duration = Number.isFinite(media.duration) ? media.duration : 0;
  const current = Number.isFinite(media.currentTime) ? media.currentTime : 0;
  player.querySelector(".current").textContent = formatTime(current);
  player.querySelector(".duration").textContent = formatTime(duration);
  player.querySelector(".media-seek").value = duration ? String(Math.round((current / duration) * 1000)) : "0";
  player.querySelectorAll('[data-action="media-toggle"]').forEach((button) => {
    button.textContent = media.paused ? "▶" : "Ⅱ";
    button.setAttribute("aria-label", media.paused ? "播放" : "暂停");
  });
  player.querySelector(".media-mute").textContent = media.muted || media.volume === 0 ? "×" : "⌁";
}

function saveMediaProgress(player, media) {
  if (!Number.isFinite(media.duration) || media.currentTime > media.duration * 0.95) {
    localStorage.removeItem(player.dataset.storageKey);
    return;
  }
  localStorage.setItem(player.dataset.storageKey, JSON.stringify({
    time: media.currentTime,
    rate: media.playbackRate,
    volume: media.volume,
  }));
}

function initHeadingObserver() {
  const headings = [...document.querySelectorAll(".md-content h2[id], .md-content h3[id]")];
  if (!headings.length) return;
  S.headingObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (!visible.length) return;
    const id = visible[0].target.id;
    document.querySelectorAll("[data-heading-id]").forEach((link) => link.classList.toggle("is-active", link.dataset.headingId === id));
  }, { root: E.scroller, rootMargin: "-12% 0px -72% 0px", threshold: [0, 1] });
  headings.forEach((heading) => S.headingObserver.observe(heading));
}

function stopObservers() {
  if (S.headingObserver) S.headingObserver.disconnect();
  S.headingObserver = null;
  if (S.masonryObserver) S.masonryObserver.disconnect();
  S.masonryObserver = null;
  if (S.currentMedia) S.currentMedia.pause();
  S.currentMedia = null;
}

function handleClick(event) {
  const headingLink = event.target.closest("[data-heading-id]");
  if (headingLink) {
    event.preventDefault();
    const heading = document.getElementById(headingLink.dataset.headingId);
    heading?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    return;
  }
  const routeButton = event.target.closest("[data-route]");
  if (routeButton) {
    location.hash = `#/${routeButton.dataset.route}`;
    return;
  }
  const hrefButton = event.target.closest("[data-href]");
  if (hrefButton) {
    location.hash = hrefButton.dataset.href.replace(/^#/, "");
    return;
  }
  const articleButton = event.target.closest("[data-article-id]");
  if (articleButton) {
    sessionStorage.setItem("article-list-hash", location.hash);
    location.hash = `#/article/${articleButton.dataset.articleId}`;
    return;
  }
  const pageButton = event.target.closest("[data-page]");
  if (pageButton && !pageButton.disabled) {
    updateRouteParams({ page: pageButton.dataset.page });
    return;
  }
  const filter = event.target.closest("[data-filter-key]");
  if (filter) {
    updateRouteParams({ [filter.dataset.filterKey]: filter.dataset.filterValue, page: "1" });
    return;
  }
  const gallery = event.target.closest("[data-gallery-index]");
  if (gallery && S.galleryArticle) {
    openLightbox(S.galleryArticle.images, Number(gallery.dataset.galleryIndex));
    return;
  }
  const libraryImage = event.target.closest("[data-library-image]");
  if (libraryImage) {
    openLightbox(S.lightboxItems, Number(libraryImage.dataset.libraryImage));
    return;
  }
  const contentImage = event.target.closest(".md-content img");
  if (contentImage) {
    const images = [...document.querySelectorAll(".md-content img")].map((image) => ({
      url: image.currentSrc || image.src,
      download_url: image.currentSrc || image.src,
      name: image.alt || "文章图片",
    }));
    openLightbox(images, [...document.querySelectorAll(".md-content img")].indexOf(contentImage));
    return;
  }

  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  if (action === "retry") renderRoute(S.route);
  else if (action === "open-search") openSearch();
  else if (action === "clear-filters") location.hash = "#/articles";
  else if (action === "back-to-articles") location.hash = sessionStorage.getItem("article-list-hash") || "#/articles";
  else if (action === "scroll-top") E.scroller.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
  else if (action === "cycle-theme") cycleTheme();
  else if (action === "open-editor") location.href = "/editor/";
  else if (action === "load-gallery") loadMoreGallery();
  else if (action === "copy-code") copyCodeBlock(event.target.closest("[data-action]"));
  else if (action === "toggle-code-wrap") toggleCodeWrap(event.target.closest("[data-action]"));
  else if (action.startsWith("media-")) handleMediaAction(event.target.closest(".media-player"), action);
}

function handleInput(event) {
  if (event.target.id === "articleSearch") {
    clearTimeout(event.target._timer);
    event.target._timer = setTimeout(() => {
      S.focusArticleSearch = true;
      updateRouteParams({ q: event.target.value.trim(), page: "1" });
    }, 300);
  }
  const player = event.target.closest(".media-player");
  if (!player) return;
  const media = player.querySelector("audio, video");
  if (event.target.classList.contains("media-seek") && Number.isFinite(media.duration)) {
    media.currentTime = (Number(event.target.value) / 1000) * media.duration;
  } else if (event.target.classList.contains("media-volume")) {
    media.volume = Number(event.target.value);
    media.muted = false;
    updateMediaUI(player, media);
  }
}

function handleChange(event) {
  if (event.target.id === "articleSort") updateRouteParams({ sort: event.target.value, page: "1" });
  if (event.target.id === "mediaYear") updateRouteParams({ year: event.target.value, page: "1" });
  const player = event.target.closest(".media-player");
  if (player && event.target.classList.contains("media-rate")) {
    const media = player.querySelector("audio, video");
    media.playbackRate = Number(event.target.value);
    saveMediaProgress(player, media);
  }
}

function handleMediaAction(player, action) {
  if (!player) return;
  const media = player.querySelector("audio, video");
  if (action === "media-toggle") {
    if (media.paused) media.play().catch(() => showToast("无法开始播放"));
    else media.pause();
  } else if (action === "media-mute") {
    media.muted = !media.muted;
    updateMediaUI(player, media);
  } else if (action === "media-fullscreen") {
    const stage = player.querySelector(".video-stage") || media;
    if (stage.requestFullscreen) stage.requestFullscreen();
  }
}

function loadMoreGallery() {
  if (!S.galleryArticle) return;
  const gallery = document.getElementById("articleGallery");
  const grid = gallery?.querySelector(".photo-grid");
  if (!gallery || !grid) return;

  const start = S.galleryVisible;
  S.galleryVisible = Math.min(start + 24, S.galleryArticle.images.length);
  grid.insertAdjacentHTML("beforeend", S.galleryArticle.images.slice(start, S.galleryVisible)
    .map((image, offset) => galleryTile(image, start + offset)).join(""));

  const loadMore = gallery.querySelector('[data-action="load-gallery"]');
  const remaining = S.galleryArticle.images.length - S.galleryVisible;
  if (!remaining) loadMore?.remove();
  else if (loadMore) loadMore.innerHTML = `继续展开 ${Math.min(24, remaining)} 张 <span>↓</span>`;
  initMasonryGalleries();
}

function handleKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openSearch();
    return;
  }
  if (E.lightbox.open) {
    if (event.key === "ArrowLeft") moveLightbox(-1);
    else if (event.key === "ArrowRight") moveLightbox(1);
    return;
  }
  if (E.searchDialog.open) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSearchSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSearchSelection(-1);
    } else if (event.key === "Enter" && S.searchIndex >= 0) {
      event.preventDefault();
      const item = S.searchItems[S.searchIndex];
      if (item) location.hash = `#/article/${item.id}`;
    }
  }
  if ((event.key === "Enter" || event.key === " ") && event.target.matches(".md-content img")) {
    event.preventDefault();
    event.target.click();
  }
}

function handleScroll() {
  updateReadingProgress();
  if (S.route.name === "article") {
    clearTimeout(S.saveScrollTimer);
    S.saveScrollTimer = setTimeout(() => {
      sessionStorage.setItem(`reading-scroll:${S.route.id}`, String(Math.round(E.scroller.scrollTop)));
    }, 180);
  }
}

function updateReadingProgress() {
  if (S.route.name !== "article") {
    E.progress.value = 0;
    return;
  }
  const max = E.scroller.scrollHeight - E.scroller.clientHeight;
  const percent = max > 0 ? (E.scroller.scrollTop / max) * 100 : 0;
  E.progress.value = Math.min(100, Math.max(0, percent));
}

function updateRouteParams(changes) {
  const params = new URLSearchParams(S.route.params);
  Object.entries(changes).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "" || value === "all" && key !== "type" && key !== "year") params.delete(key);
    else params.set(key, value);
  });
  const query = params.toString();
  location.hash = `#/${S.route.name}${query ? `?${query}` : ""}`;
}

function openSearch() {
  if (!E.searchDialog.open) E.searchDialog.showModal();
  requestAnimationFrame(() => E.searchInput.focus());
}

function closeSearch() {
  if (E.searchDialog?.open) E.searchDialog.close();
}

function scheduleSearch() {
  clearTimeout(S.searchTimer);
  const query = E.searchInput.value.trim();
  if (!query) {
    S.searchItems = [];
    S.searchIndex = -1;
    E.searchResults.innerHTML = `<div class="empty-state compact"><span class="empty-symbol">⌕</span><p>输入关键词，重遇某段文字</p></div>`;
    return;
  }
  E.searchResults.innerHTML = `<div class="searching"><span class="loading-mark"></span>正在本地文字中查找…</div>`;
  S.searchTimer = setTimeout(() => doSearch(query), 180);
}

async function doSearch(query) {
  try {
    const data = await fetchJSON(`/api/search?q=${encodeURIComponent(query)}`);
    if (query !== E.searchInput.value.trim()) return;
    S.searchItems = data.items;
    S.searchIndex = data.items.length ? 0 : -1;
    E.searchResults.innerHTML = data.items.length ? `
      <div class="search-summary">找到 ${data.total} 篇，显示前 ${data.items.length} 篇</div>
      ${data.items.map((item, index) => `
        <button type="button" class="search-result ${index === 0 ? "is-selected" : ""}" data-article-id="${item.id}" data-search-index="${index}">
          <span class="result-type">${typeSymbol(item.type)}</span>
          <span><strong>${highlightText(item.title, query)}</strong><small>${highlightText(item.snippet, query)}</small><em>${formatDate(item.date)} · ${esc(item.type_label)}</em></span>
          <i>↗</i>
        </button>`).join("")}` :
      `<div class="empty-state compact"><span class="empty-symbol">○</span><p>没有找到“${esc(query)}”</p></div>`;
  } catch {
    E.searchResults.innerHTML = `<div class="empty-state compact"><span class="empty-symbol">!</span><p>搜索暂时不可用</p></div>`;
  }
}

function moveSearchSelection(direction) {
  if (!S.searchItems.length) return;
  S.searchIndex = (S.searchIndex + direction + S.searchItems.length) % S.searchItems.length;
  document.querySelectorAll("[data-search-index]").forEach((item, index) => {
    item.classList.toggle("is-selected", index === S.searchIndex);
    if (index === S.searchIndex) item.scrollIntoView({ block: "nearest" });
  });
}

function openLightbox(items, index = 0) {
  if (!items?.length) return;
  S.lightboxItems = items;
  S.lightboxIndex = clamp(index, 0, items.length - 1);
  updateLightbox();
  if (!E.lightbox.open) E.lightbox.showModal();
}

function updateLightbox() {
  const item = S.lightboxItems[S.lightboxIndex];
  if (!item) return;
  E.lightboxImage.src = item.url;
  E.lightboxImage.alt = item.name || "";
  E.lightboxCaption.textContent = item.name || "";
  E.lightboxCounter.textContent = `${S.lightboxIndex + 1} / ${S.lightboxItems.length}`;
  E.lightboxDownload.href = item.download_url || item.url;
  E.lightboxPrev.hidden = S.lightboxItems.length < 2;
  E.lightboxNext.hidden = S.lightboxItems.length < 2;
}

function moveLightbox(direction) {
  if (S.lightboxItems.length < 2) return;
  S.lightboxIndex = (S.lightboxIndex + direction + S.lightboxItems.length) % S.lightboxItems.length;
  updateLightbox();
}

function closeLightbox() {
  if (E.lightbox.open) E.lightbox.close();
  E.lightboxImage.src = "";
}

function openSidebar() {
  E.sidebar.classList.add("is-open");
  E.scrim.classList.add("is-visible");
}

function closeSidebar() {
  E.sidebar?.classList.remove("is-open");
  E.scrim?.classList.remove("is-visible");
}

function cycleTheme() {
  const modes = ["system", "light", "dark"];
  S.themeMode = modes[(modes.indexOf(S.themeMode) + 1) % modes.length];
  localStorage.setItem("theme-mode", S.themeMode);
  applyTheme();
}

function applyTheme() {
  const dark = S.themeMode === "dark" || (S.themeMode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const labels = { system: ["◐", "跟随系统"], light: ["☀", "浅色模式"], dark: ["☾", "深色模式"] };
  [E.themeIcon.textContent, E.themeLabel.textContent] = labels[S.themeMode];
}

function setFontSize(value) {
  S.fontSize = clamp(value, 15, 21);
  localStorage.setItem("reader-font", String(S.fontSize));
  applyFontSize();
}

function applyFontSize() {
  document.documentElement.dataset.fontSize = String(S.fontSize);
  E.fontValue.textContent = S.fontSize;
  E.fontDown.disabled = S.fontSize <= 15;
  E.fontUp.disabled = S.fontSize >= 21;
}

function showToast(message) {
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = message;
  E.toast.appendChild(item);
  setTimeout(() => item.remove(), 2600);
}

async function fetchJSON(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function coverImage(article, className) {
  if (!article.cover) return `<span class="cover-fallback ${className}">${typeSymbol(article.type)}</span>`;
  return `<img class="${className}" src="${attr(article.cover)}" alt="" loading="lazy" decoding="async">`;
}

function typeBadge(article) {
  return `<span class="type-badge ${article.type}"><i>${typeSymbol(article.type)}</i>${esc(article.type_label)}</span>`;
}

function typeSymbol(type) {
  return ({ normal: "文", gallery: "图", media: "声" })[type] || "文";
}

function articleMeta(article) {
  if (article.video_count) return `${article.video_count} 个视频`;
  if (article.audio_count) return `${article.audio_count} 个音频`;
  if (article.image_count) return `${article.image_count} 张图片`;
  return "约 1 分钟";
}

function readingTime(article) {
  const text = String(article.content_html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ");
  return `约 ${Math.max(1, Math.ceil(text.length / 550))} 分钟阅读`;
}

function formatDate(value) {
  return value ? value.slice(0, 10).replaceAll("-", ".") : "日期未记录";
}

function formatDateLong(value) {
  if (!value) return "日期未记录";
  const [year, month, day] = value.slice(0, 10).split("-");
  return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
}

function compactNumber(value) {
  const number = Number(value) || 0;
  if (number >= 10000) return `${(number / 10000).toFixed(1)}万`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}k`;
  return String(number);
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

function pageWindow(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const values = new Set([1, total, current - 1, current, current + 1].filter((value) => value >= 1 && value <= total));
  const sorted = [...values].sort((a, b) => a - b);
  const output = [];
  sorted.forEach((value, index) => {
    if (index && value - sorted[index - 1] > 1) output.push("…");
    output.push(value);
  });
  return output;
}

function highlightText(value, query) {
  const safe = esc(value || "");
  const needle = esc(query || "");
  if (!needle) return safe;
  return safe.replace(new RegExp(escapeRegExp(needle), "gi"), (match) => `<mark>${match}</mark>`);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function attr(value) {
  return esc(value).replaceAll("`", "&#96;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function reducedMotion() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}
