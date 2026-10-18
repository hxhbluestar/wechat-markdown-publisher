/** Sync review shares the existing account/check/state bindings, but owns no API calls. */
export function syncDialogMarkup() {
  return `<dialog class="sync-dialog" id="syncDialog" aria-labelledby="syncDialogTitle" aria-describedby="syncDialogHint">
    <header class="sync-dialog-heading"><div><small>微信公众号</small><h2 id="syncDialogTitle">同步到公众号草稿箱</h2><p id="syncArticleTitle"></p></div><button id="closeSyncDialog" type="button" aria-label="关闭同步窗口">×</button></header>
    <div class="sync-dialog-body">
      <p class="sync-dialog-hint" id="syncDialogHint">检查目标账号与文章信息，确认后同步。同步完成后，请在微信中复核排版。</p>
      <section class="account-status" id="accountStatus">
        <div class="account-status-heading"><span class="status-dot" id="accountDot"></span><div><strong>目标公众号</strong><small id="accountSummary">尚未绑定</small></div></div>
        <select id="accountSelect" aria-label="选择目标公众号"><option value="">请选择公众号</option></select>
        <button class="manage-account-button" id="manageAccounts" type="button">管理公众号</button>
      </section>
      <div class="sync-review-heading"><h3>同步前检查</h3><button class="toolbar-button" type="button" id="openPreflight">详细检查</button></div>
      <div class="check-list" id="preflightList"></div>
      <div class="sync-blocker" id="syncBlocker" hidden></div>
      <div class="network-status-slot" id="syncNetworkStatus"></div>
      <div class="sync-review-heading"><h3>同步记录</h3><button class="toolbar-button" type="button" id="openSyncJobs">任务与进度</button></div>
      <div class="publish-state" id="publishState"></div>
      <details class="sync-advanced"><summary>高级操作</summary><p>直接发布默认关闭。通常只需同步草稿，在公众号后台复核后发布。</p><button class="publish-button" id="publishDraft" type="button" disabled>确认发布</button></details>
    </div>
    <footer class="sync-dialog-footer"><button class="toolbar-button" id="cancelSyncDialog" type="button">返回编辑</button><button class="sync-button" id="syncDraft" type="button" disabled>同步到草稿箱</button></footer>
  </dialog>`;
}

export function connectEditorLayout(
  document,
  { hasDraft = () => false, getTitle = () => "", onOpenSync = () => {} } = {},
) {
  const dialog = document.querySelector("#syncDialog");
  const entry = document.querySelector("#openSyncDialog");
  const closeSync = () => {
    if (dialog.hasAttribute("open")) dialog.close();
  };
  const refresh = () => {
    entry.disabled = !hasDraft();
    document.querySelector("#syncArticleTitle").textContent =
      getTitle() || "未命名文章";
    if (!hasDraft()) closeSync();
  };
  const openSync = () => {
    if (!hasDraft()) return;
    onOpenSync();
    refresh();
    if (!dialog.hasAttribute("open")) {
      entry.focus?.();
      dialog.showModal();
    }
  };
  entry.addEventListener("click", openSync);
  for (const id of [
    "closeSyncDialog",
    "cancelSyncDialog",
    "syncDraft",
    "openPreflight",
    "openSyncJobs",
    "manageAccounts",
    "publishDraft",
  ]) {
    document
      .getElementById(id)
      ?.addEventListener("click", closeSync, { capture: true });
  }
  // A backdrop click closes; padding and empty areas inside the dialog do not.
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      closeSync();
  });
  const strip = document.querySelector("#company-network-strip");
  if (strip) document.querySelector("#syncNetworkStatus").append(strip);

  const grid = document.querySelector(".compose-grid");
  const buttons = [...document.querySelectorAll("[data-workspace-view]")];
  const setView = (view) => {
    grid.dataset.workspaceView = view;
    for (const button of buttons)
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.workspaceView === view),
      );
  };
  for (const button of buttons)
    button.addEventListener("click", () =>
      setView(button.dataset.workspaceView),
    );
  setView("source");

  const drawers = [...document.querySelectorAll(".preview-drawers > details")];
  const toolsBar = document.querySelector(".preview-drawers");
  const stage = document.querySelector(".phone-stage");
  const sizeDrawers = () => {
    if (stage && toolsBar)
      toolsBar.style.setProperty(
        "--preview-tools-max-height",
        Math.max(0, stage.clientHeight - 8) + "px",
      );
  };
  if (stage && document.defaultView?.ResizeObserver)
    new document.defaultView.ResizeObserver(sizeDrawers).observe(stage);
  for (const drawer of drawers)
    drawer.addEventListener("toggle", () => {
      if (drawer.open) {
        sizeDrawers();
        for (const other of drawers) if (other !== drawer) other.open = false;
      }
    });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape")
      for (const drawer of drawers) drawer.open = false;
  });
  refresh();
  return { openSync, closeSync, refresh, showSource: () => setView("source") };
}
