// Only run against serve-editor-layout.py --workflow-simple. All drafts/accounts
// are synthetic and the server rejects every WeChat sync before job creation.
const frame = document.querySelector("#editor"),
  report = document.querySelector("#report"),
  checks = [];
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
const tick = () =>
  new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
const check = (ok, label) => {
  if (!ok) throw new Error(label);
  checks.push(label);
  report.textContent = `${checks.length} checks passed\n${checks.join("\n")}`;
};
async function until(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await pause();
  }
}
const state = () => fetch("/qa/state").then((response) => response.json());
async function json(path, options = {}) {
  const response = await fetch(path, options),
    value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
let observer;
try {
  const initial = await state(),
    seed = initial.workflow_seed;
  check(
    !!seed && Array.isArray(initial.sync_requests),
    "Isolated --workflow-simple fixture is active",
  );
  const config = await json("/api/editor/config");
  const loaded = new Promise((resolve) => {
    frame.onload = resolve;
  });
  frame.src = "/editor/?workflow-simple-acceptance=1";
  await loaded;
  const doc = frame.contentDocument,
    win = frame.contentWindow,
    $ = (selector) => doc.querySelector(selector);
  await until(
    () =>
      $(`.draft-open[data-draft-id="${seed.draft_id}"]`) &&
      $("#accountSelect").options.length > 1,
    "real editor and synthetic account",
  );
  const modalOpenings = [];
  observer = new win.MutationObserver((records) => {
    for (const record of records)
      if (record.target.open) modalOpenings.push(record.target.id);
  });
  for (const id of ["workflowDialog", "proofreadingDialog"])
    observer.observe($("#" + id), {
      attributes: true,
      attributeFilter: ["open"],
    });
  $(`.draft-open[data-draft-id="${seed.draft_id}"]`).click();
  await until(
    () =>
      $("#metaTitle").value === seed.title &&
      $("#output").textContent.includes("TODO"),
    "seed article is open",
  );
  check($("#metaSource").value === "", "Source is deliberately empty");
  check(
    $("#proofreadDraft").textContent.includes("1"),
    "The real editor detects the synthetic typo",
  );

  const savedTitle = "导入前保留未保存的标题";
  $("#metaTitle").value = savedTitle;
  $("#metaTitle").dispatchEvent(new win.Event("input", { bubbles: true }));
  await until(
    () => $("#saveState").textContent.includes("未保存"),
    "current edit becomes dirty",
  );
  const beforeImport = (await state()).mutations.length,
    picker = $("#markdownFile");
  let chooserOpened = 0;
  const choose = (event) => {
    event.preventDefault();
    chooserOpened++;
  };
  picker.addEventListener("click", choose);
  $("#importMarkdown").click();
  check(
    chooserOpened === 1,
    "Primary Markdown entry directly opens the native file picker",
  );
  check(
    !$("#workflowDialog").open,
    "Primary import does not open a conversion workbench",
  );
  const markdown =
      "# Markdown 直接导入验收\n\n原始文本、缩进与链接应完整保留。\n\n```python\ndef run():\n    print('exact source')\n```\n\n[ROCm](https://rocm.blogs.amd.com/)\n",
    transfer = new win.DataTransfer();
  transfer.items.add(
    new win.File([markdown], "synthetic-direct.md", { type: "text/markdown" }),
  );
  picker.files = transfer.files;
  picker.dispatchEvent(new win.Event("change", { bubbles: true }));
  await until(
    () =>
      $("#metaTitle").value === "Markdown 直接导入验收" &&
      $("#importMarkdown").disabled === false,
    "Markdown import finishes",
  );
  await tick();
  const importedList = await json("/api/editor/drafts"),
    importedSummary = importedList.items.find(
      (draft) => draft.title === "Markdown 直接导入验收",
    );
  check(!!importedSummary, "Direct import creates one normal local article");
  check(
    importedList.items.filter(
      (draft) => draft.title === "Markdown 直接导入验收",
    ).length === 1,
    "One file selection creates one draft",
  );
  const imported = await json(`/api/editor/drafts/${importedSummary.id}`),
    preserved = await json(`/api/editor/drafts/${seed.draft_id}`),
    importState = await state(),
    mutations = importState.mutations.slice(beforeImport);
  check(
    imported.content === markdown,
    "Imported source matches the selected Markdown byte-for-byte",
  );
  check(
    preserved.metadata.title === savedTitle &&
      preserved.content === seed.content,
    "Current dirty metadata is saved and existing article source is preserved",
  );
  const saveIndex = mutations.findIndex(
      ([method, path]) =>
        method === "PUT" && path === `/api/editor/drafts/${seed.draft_id}`,
    ),
    createIndex = mutations.findIndex(
      ([method, path]) => method === "POST" && path === "/api/editor/drafts",
    );
  check(
    saveIndex >= 0 && createIndex > saveIndex,
    "Current save reaches the server before new-draft creation",
  );
  check(
    !mutations.some(([, path]) => path === "/api/editor/import"),
    "Direct Markdown import does not call conversion endpoints",
  );
  check(
    picker.value === "" && !$("#workflowDialog").open,
    "Chooser resets and no import workbench is left open",
  );
  picker.removeEventListener("click", choose);

  $(`.draft-open[data-draft-id="${seed.draft_id}"]`).click();
  await until(
    () => $("#metaTitle").value === savedTitle && !$("#syncDraft").disabled,
    "complete synthetic article is ready to sync",
  );
  check(
    modalOpenings.length === 0,
    "Import and opening an article show no advisory dialogs",
  );
  $("#openSyncDialog").click();
  await until(() => $("#syncDialog").open, "normal sync confirmation dialog");
  check(
    !$("#syncDraft").disabled,
    "Typo, empty source and TODO leave draft sync enabled",
  );
  $("#syncDraft").click();
  await until(
    async () => (await state()).sync_requests.length === 1,
    "advisory-only article reaches the blocked synthetic sync endpoint",
  );
  await until(
    () => !$("#syncDraft").disabled,
    "synthetic 403 exits the request cleanly",
  );
  await tick();
  const sent = (await state()).sync_requests[0];
  check(
    sent.path === `/api/wechat/drafts/${seed.draft_id}/sync`,
    "Real editor sends the intended draft sync request",
  );
  check(
    sent.account_id === seed.account_id,
    "Sync keeps the selected synthetic account",
  );
  check(
    Array.isArray(sent.acknowledged) && sent.acknowledged.length === 0,
    "Sync needs no advisory acknowledgement checklist",
  );
  check(
    /^[a-f0-9]{64}$/.test(sent.preflight_fingerprint || ""),
    "Automatic preflight still binds a valid server fingerprint",
  );
  check(
    modalOpenings.length === 0 &&
      !$("#workflowDialog").open &&
      !$("#proofreadingDialog").open,
    "No typo or advisory modal interrupts sync",
  );

  // A reference-style image is valid Markdown. It reaches full preflight, which
  // must catch the missing asset before any external sync request is sent.
  const complete = await json(`/api/editor/drafts/${seed.draft_id}`),
    brokenSource =
      complete.content +
      "\n\n![缺失图片][missing-image]\n\n[missing-image]: images/missing.png\n";
  await json(`/api/editor/drafts/${seed.draft_id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Editor-Token": config.csrf_token,
    },
    body: JSON.stringify({
      content: brokenSource,
      metadata: complete.metadata,
      revision: complete.revision,
    }),
  });
  $(`.draft-open[data-draft-id="${seed.draft_id}"]`).click();
  await until(
    () => !!$('#output img[src*="missing.png"]'),
    "missing reference-style image is loaded into the editor",
  );
  await until(
    () => !$("#syncDraft").disabled,
    "full preflight can check reference-style image",
  );
  $("#openSyncDialog").click();
  await until(() => $("#syncDialog").open, "sync review for missing image");
  $("#syncDraft").click();
  await until(
    () =>
      $("#workflowDialog").open && !!$("#workflowBody .workflow-issue.blocker"),
    "missing asset opens a hard-blocker report",
  );
  await until(
    () => !$("#syncDraft").disabled,
    "hard-blocker check has finished",
  );
  const blocked = await state();
  check(
    blocked.sync_requests.length === 1,
    "Missing image prevents a second sync POST",
  );
  check(
    /缺失|不存在|missing\.png/.test($("#workflowBody").textContent),
    "Hard-blocker report identifies the missing image",
  );
  check(
    !$("#proofreadingDialog").open,
    "Hard-blocker report does not force typo corrections",
  );
  check(
    !$("#workflowBody input[type=checkbox]"),
    "Detailed report contains no acknowledgement checklist",
  );
  const draftAfter = await json(`/api/editor/drafts/${seed.draft_id}`);
  check(
    draftAfter.content === brokenSource,
    "Checking and failed synthetic sync do not rewrite article text",
  );
  window.workflowSimpleAcceptance = {
    passed: true,
    checks,
    syncRequests: blocked.sync_requests,
  };
  document.body.dataset.testStatus = "passed";
  report.textContent = `${checks.length} checks passed.\n${checks.join("\n")}`;
} catch (error) {
  window.workflowSimpleAcceptance = {
    passed: false,
    checks,
    error: error.message,
  };
  document.body.dataset.testStatus = "failed";
  report.textContent = `${checks.length} checks before FAIL ${error.message}\n${checks.join("\n")}`;
  console.error(error);
} finally {
  observer?.disconnect();
  document.body.dataset.results = JSON.stringify(
    window.workflowSimpleAcceptance,
  );
}
