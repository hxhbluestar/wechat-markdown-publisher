import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import * as layout from "../frontend/editor-layout.mjs";

function harness() {
  const { document } = parseHTML(
    `<html><body><button id="openSyncDialog">同步到公众号</button><div class="compose-grid"><div class="source-panel"></div><div class="preview-panel"></div></div>${layout.syncDialogMarkup?.() || ""}<div class="preview-drawers"><details class="preview-settings"><summary>排版与设备</summary></details><details data-authoring-tools><summary>大纲与微调</summary></details></div><button data-workspace-view="source">编辑</button><button data-workspace-view="preview">预览</button></body></html>`,
  );
  const dialog = document.querySelector("#syncDialog");
  if (dialog) {
    dialog.showModal = () => dialog.setAttribute("open", "");
    dialog.close = () => {
      dialog.removeAttribute("open");
      dialog.dispatchEvent(new document.defaultView.Event("close"));
    };
  }
  let hasDraft = true,
    opens = 0;
  const controller = layout.connectEditorLayout?.(document, {
    hasDraft: () => hasDraft,
    getTitle: () => "<script>unsafe</script>",
    onOpenSync: () => opens++,
  });
  return {
    document,
    dialog,
    controller,
    opens: () => opens,
    setDraft: (value) => (hasDraft = value),
    click: (selector) =>
      document
        .querySelector(selector)
        ?.dispatchEvent(
          new document.defaultView.Event("click", { bubbles: true }),
        ),
  };
}

test("sync review is a closed labelled dialog outside the two editing columns", () => {
  const h = harness();
  assert.ok(h.dialog, "sync review dialog exists");
  assert.equal(h.dialog.hasAttribute("open"), false);
  assert.equal(h.dialog.closest(".compose-grid"), null);
  assert.equal(h.document.querySelectorAll(".compose-grid > *").length, 2);
  assert.ok(h.dialog.querySelector("#accountSelect"));
  assert.ok(h.dialog.querySelector("#preflightList"));
  assert.ok(h.dialog.querySelector("#publishState"));
  assert.ok(h.dialog.querySelector("#openPreflight"));
  assert.ok(h.dialog.querySelector("#openSyncJobs"));
  assert.ok(h.dialog.querySelector("#syncDraft"));
  assert.ok(
    h.document.getElementById(h.dialog.getAttribute("aria-labelledby")),
  );
});

test("opening sync only reviews current state and renders article titles as text", () => {
  const h = harness();
  h.click("#openSyncDialog");
  assert.ok(h.dialog?.hasAttribute("open"), "entry opens sync review");
  assert.equal(h.opens(), 1);
  assert.equal(
    h.dialog.querySelector("#syncArticleTitle").textContent,
    "<script>unsafe</script>",
  );
  assert.equal(h.dialog.querySelectorAll("script").length, 0);
  h.click("#closeSyncDialog");
  assert.equal(h.dialog.hasAttribute("open"), false);
});

test("no-draft state disables sync entry and cannot open an empty review", () => {
  const h = harness();
  assert.ok(h.controller, "layout controller exists");
  h.setDraft(false);
  h.controller.refresh();
  assert.equal(h.document.querySelector("#openSyncDialog").disabled, true);
  h.controller.openSync();
  assert.equal(h.dialog.hasAttribute("open"), false);
  assert.equal(h.opens(), 0);
});

test("closing or starting a review action leaves no underlying sync dialog open", () => {
  const h = harness();
  assert.ok(h.controller, "layout controller exists");
  for (const action of [
    "#cancelSyncDialog",
    "#openPreflight",
    "#openSyncJobs",
    "#manageAccounts",
    "#syncDraft",
    "#publishDraft",
  ]) {
    h.controller.openSync();
    h.click(action);
    assert.equal(h.dialog.hasAttribute("open"), false, action);
  }
});

test("compact workspace switch changes visible pane without changing article state", () => {
  const h = harness();
  h.click('[data-workspace-view="preview"]');
  assert.equal(
    h.document.querySelector(".compose-grid").dataset.workspaceView,
    "preview",
  );
  assert.equal(
    h.document
      .querySelector('button[data-workspace-view="preview"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  h.click('button[data-workspace-view="source"]');
  assert.equal(
    h.document.querySelector(".compose-grid").dataset.workspaceView,
    "source",
  );
  assert.equal(h.opens(), 0);
});

test("source navigation reveals the editor after a compact preview selection", () => {
  const h = harness();
  h.click('button[data-workspace-view="preview"]');
  assert.equal(
    typeof h.controller.showSource,
    "function",
    "source navigation has a shared reveal action",
  );
  h.controller.showSource();
  assert.equal(
    h.document.querySelector(".compose-grid").dataset.workspaceView,
    "source",
  );
  assert.equal(
    h.document
      .querySelector('button[data-workspace-view="source"]')
      .getAttribute("aria-pressed"),
    "true",
  );
});
