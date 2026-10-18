const frame = document.getElementById("editor"),
  report = document.getElementById("report");
const results = [],
  checks = [];
const sizes = [
  [3840, 1958],
  [2560, 1440],
  [1920, 1080],
  [1440, 900],
  [1366, 768],
  [1366, 600],
  [1180, 768],
  [1024, 768],
  [901, 740],
  [900, 740],
  [820, 900],
  [768, 1024],
  [390, 844],
  [390, 500],
];
const tick = () =>
  new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
const check = (ok, label) => {
  if (!ok) throw new Error(label);
  checks.push(label);
};
async function until(fn) {
  const deadline = Date.now() + 15000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("Timed out loading editor");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
try {
  for (const [width, height] of sizes) {
    frame.style.width = width + "px";
    frame.style.height = height + "px";
    const loaded = new Promise((resolve) => (frame.onload = resolve));
    frame.src = "/editor/?layout-qa=" + width;
    await loaded;
    const doc = frame.contentDocument,
      win = frame.contentWindow;
    await until(() => doc.querySelector(".draft-open"));
    doc.querySelector(".draft-open").click();
    await until(() => !doc.querySelector("#composeGrid").hidden);
    await until(() => doc.querySelector("#output").textContent.length > 100);
    await tick();
    const $ = (s) => doc.querySelector(s),
      rect = (s) => $(s).getBoundingClientRect(),
      style = (s) => win.getComputedStyle($(s));
    const grid = rect(".compose-grid"),
      stage = rect(".phone-stage");
    const label = width + "×" + height;
    check(
      $(".compose-grid").children.length === 2,
      label + ": only edit and preview occupy the grid",
    );
    check(
      rect(".source-panel").height >= grid.height - 2,
      label + ": source uses full workspace height",
    );
    check(
      !$(".sync-dialog").hasAttribute("open"),
      label + ": publishing is initially closed",
    );
    check(
      !$(".preview-settings").open && !$("[data-authoring-tools]").open,
      label + ": detailed tools initially collapsed",
    );
    check(
      rect(".editor-toolbar").right <= width + 1,
      label + ": top bar fits screen",
    );
    check(
      doc.documentElement.scrollWidth <= width + 1,
      label + ": page has no horizontal overflow",
    );
    if (width > 900) {
      check(
        Math.abs(rect(".preview-panel").y - grid.y) < 2 &&
          rect(".preview-panel").height >= grid.height - 2,
        label + ": both columns stay in a single full-height row",
      );
      check(
        stage.height >= grid.height * 0.65,
        label + ": preview keeps at least 65 percent of workspace height",
      );
    } else {
      check(
        style(".preview-panel").visibility === "hidden",
        label + ": compact editor has one active pane",
      );
      const source = $(".cm-scroller");
      source.scrollTop = source.scrollHeight * 0.3;
      await tick();
      check(
        $(".phone-stage").scrollTop > 0,
        label + ": compact source scroll keeps hidden preview in sync",
      );
      $('button[data-workspace-view="preview"]').click();
      await tick();
      check(
        style(".source-panel").visibility === "hidden" &&
          rect(".preview-panel").height >= grid.height - 2,
        label + ": compact preview gets full workspace",
      );
      const previousSourceTop = source.scrollTop;
      $(".phone-stage").scrollTop = $(".phone-stage").scrollHeight * 0.5;
      await tick();
      check(
        Math.abs(source.scrollTop - previousSourceTop) > 5,
        label + ": compact preview scroll keeps hidden editor in sync",
      );
    }
    const stageHeight = rect(".phone-stage").height;
    $(".preview-settings summary").click();
    await tick();
    check(
      Math.abs(rect(".phone-stage").height - stageHeight) < 2,
      label + ": opening settings does not shrink preview",
    );
    check(
      rect(".typography-options").right <= width + 1,
      label + ": settings do not escape screen",
    );
    const device = $("#previewWidthSelect");
    device.value = "ipad-air11";
    device.dispatchEvent(new win.Event("change", { bubbles: true }));
    await tick();
    check(
      $("#previewDeviceStatus").textContent.includes("iPad Air"),
      label + ": device settings still operate",
    );
    $("[data-authoring-tools] summary").click();
    await tick();
    check(
      !$("[data-authoring-tools]").open || !$(".preview-settings").open,
      label + ": popovers do not overlap",
    );
    check(
      rect(".authoring-tools-body").bottom <= height + 2,
      label + ": writing controls remain reachable",
    );
    $("[data-authoring-tools] summary").click();
    await tick();
    if (width <= 900) {
      $("[data-authoring-tools] summary").click();
      await tick();
      $("[data-authoring-outline] button").click();
      await tick();
      check(
        style(".source-panel").visibility !== "hidden" &&
          style(".preview-panel").visibility === "hidden",
        label + ": outline location reveals its source target",
      );
      $('button[data-workspace-view="preview"]').click();
      await tick();
      if ($("[data-authoring-tools]").open) {
        $("[data-authoring-tools] summary").click();
        await tick();
      }
    }
    const before = JSON.stringify(
      await fetch("/qa/state").then((r) => r.json()),
    );
    $("#openSyncDialog").click();
    await tick();
    const dialog = $("#syncDialog"),
      box = rect("#syncDialog");
    check(
      dialog.open && dialog.matches(":modal"),
      label + ": entry opens a native modal",
    );
    check(
      style("#syncDialogTitle").color === style("#syncDialog").color,
      label + ": article theme cannot turn dialog heading white",
    );
    check(
      [...doc.querySelectorAll("dialog > header h2")].every(
        (h) =>
          win.getComputedStyle(h).color ===
          win.getComputedStyle(h.closest("dialog")).color,
      ),
      label + ": other editor modal headings retain their UI colors",
    );
    check(
      dialog.contains($("#accountSelect")) &&
        dialog.contains($("#company-network-strip")),
      label + ": account and network are in sync dialog",
    );
    check(
      box.x >= 0 &&
        box.right <= width + 1 &&
        box.y >= 0 &&
        box.bottom <= height + 1,
      label + ": modal fits viewport",
    );
    check(
      rect("#syncDraft").bottom <= height && rect("#syncDraft").top >= 0,
      label + ": confirmation action always visible",
    );
    $("#closeSyncDialog").click();
    await tick();
    check(!dialog.open, label + ": close returns to editor");
    check(
      doc.activeElement.id === "openSyncDialog",
      label + ": focus returns to sync entry",
    );
    const after = JSON.stringify(
      await fetch("/qa/state").then((r) => r.json()),
    );
    check(
      before === after,
      label + ": opening and closing review writes no drafts or sync requests",
    );
    results.push({
      width,
      height,
      passed: true,
      stageHeight,
      gridHeight: grid.height,
    });
    report.textContent =
      results.length + " sizes / " + checks.length + " checks passed";
  }
  window.layoutAcceptance = { passed: true, results, checks };
  document.body.dataset.testStatus = "passed";
  report.textContent =
    results.length +
    " sizes / " +
    checks.length +
    " checks passed.\n" +
    results.map((r) => "PASS " + r.width + "×" + r.height).join("\n");
} catch (error) {
  window.layoutAcceptance = {
    passed: false,
    results,
    checks,
    error: error.message,
  };
  document.body.dataset.testStatus = "failed";
  report.textContent = checks.length + " checks before FAIL " + error.message;
  console.error(error);
}
document.body.dataset.results = JSON.stringify(window.layoutAcceptance);
