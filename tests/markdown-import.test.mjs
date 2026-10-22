import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import {
  createMarkdownImporter,
  connectMarkdownFilePicker,
} from "../frontend/markdown-import.mjs";

const file = { name: "AI article.md" };
function fixture(overrides = {}) {
  const state = { id: "original", dirty: true },
    events = [];
  const adapters = {
    getDraftId: () => state.id,
    isDirty: () => state.dirty,
    readFile: async (source) => {
      events.push(["read", source.name]);
      return "# AI article\n\n```python\n  print(1)\n```";
    },
    saveDraft: async () => {
      events.push(["save", state.id]);
      state.dirty = false;
      return { id: state.id };
    },
    createDraft: async (content, name) => {
      events.push(["create", content, name]);
      return { id: "imported" };
    },
    refreshDrafts: async () => events.push(["refresh"]),
    openDraft: async (id) => {
      events.push(["open", id]);
      state.id = id;
    },
    ...overrides,
  };
  return { state, events, run: createMarkdownImporter(adapters) };
}

test("one Markdown selection saves the current edits then creates and opens the new draft without a conversion workbench", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(file), {
    draft: { id: "imported" },
    opened: true,
  });
  assert.deepEqual(
    f.events.map((e) => e[0]),
    ["read", "save", "create", "refresh", "open"],
  );
  assert.equal(f.events[2][1], "# AI article\n\n```python\n  print(1)\n```");
  assert.equal(f.events[2][2], file.name);
});

test("a failed current save aborts before creating a draft and retains visible input", async () => {
  const f = fixture({ saveDraft: async () => null });
  await assert.rejects(f.run(file), /当前修改保存失败/);
  assert.deepEqual(
    f.events.map((e) => e[0]),
    ["read"],
  );
  assert.equal(f.state.dirty, true);
  assert.equal(f.state.id, "original");
});

test("a newer edit arriving during the pre-import save aborts before creation", async () => {
  const f = fixture({ saveDraft: async () => ({ id: "original" }) });
  await assert.rejects(f.run(file), /当前修改保存失败/);
  assert.deepEqual(
    f.events.map((e) => e[0]),
    ["read"],
  );
});

test("failed file reading leaves the current draft untouched without any save or create request", async () => {
  const f = fixture({
    readFile: async () => {
      throw new Error("无法读取 Markdown");
    },
  });
  await assert.rejects(f.run(file), /无法读取/);
  assert.deepEqual(f.events, []);
  assert.equal(f.state.dirty, true);
});

test("the direct import accepts Markdown files and redirects other formats to advanced import without reading or saving", async () => {
  for (const name of [
    "article.zip",
    "article.docx",
    "article.html",
    "article.txt",
  ]) {
    const f = fixture();
    await assert.rejects(f.run({ name }), /Markdown.*创作工具/);
    assert.deepEqual(f.events, []);
  }
  const f = fixture();
  await f.run({ name: "ARTICLE.MARKDOWN" });
  assert.equal(f.state.id, "imported");
});

test("opening an imported article requests preservation of any new in-flight edits", async () => {
  const f = fixture({
    openDraft: async (id, options) => {
      assert.equal(id, "imported");
      assert.deepEqual(options, { preserveChanges: true });
    },
  });
  await f.run(file);
});

test("switching articles while reading aborts before saving or creating", async () => {
  let finish;
  const f = fixture({
    readFile: () => new Promise((resolve) => (finish = resolve)),
  });
  const pending = f.run(file);
  f.state.id = "other";
  finish("# New");
  await assert.rejects(pending, /稿件已切换/);
  assert.deepEqual(f.events, []);
});

test("edits made during import creation are saved again before opening the new article", async () => {
  let finish;
  const f = fixture({
    createDraft: () => new Promise((resolve) => (finish = resolve)),
  });
  const pending = f.run(file);
  await new Promise((resolve) => setImmediate(resolve));
  f.state.dirty = true;
  finish({ id: "imported" });
  await pending;
  assert.deepEqual(
    f.events.map((e) => e[0]),
    ["read", "save", "refresh", "save", "open"],
  );
  assert.equal(f.state.dirty, false);
});

test("a failed late save retains current edits and makes the already imported article available in the list", async () => {
  let saves = 0;
  const f = fixture({
    saveDraft: async () => {
      if (++saves === 1) {
        f.state.dirty = false;
        return { id: "original" };
      }
      return null;
    },
    createDraft: async () => {
      f.state.dirty = true;
      return { id: "imported" };
    },
  });
  await assert.rejects(f.run(file), /新稿已导入.*从稿件列表打开/);
  assert.deepEqual(
    f.events.map((e) => e[0]),
    ["read", "refresh"],
  );
  assert.equal(f.state.dirty, true);
  assert.equal(f.state.id, "original");
});

test("an article switch during creation refreshes the list and does not steal the active article", async () => {
  const f = fixture({
    createDraft: async () => {
      f.state.id = "other";
      return { id: "imported" };
    },
  });
  assert.deepEqual(await f.run(file), {
    draft: { id: "imported" },
    opened: false,
  });
  assert.deepEqual(
    f.events.map((e) => e[0]),
    ["read", "save", "refresh"],
  );
  assert.equal(f.state.id, "other");
});

test("both visible import entries open the native Markdown chooser directly; cancel creates nothing", async () => {
  const { document } = parseHTML(
    '<button id="importMarkdown">导入 Markdown</button><button data-open-import>选择 Markdown</button><input id="markdownFile" type="file">',
  );
  const input = document.querySelector("#markdownFile");
  let picks = 0,
    imports = 0;
  input.click = () => picks++;
  const controls = connectMarkdownFilePicker(document, {
    onFile: async () => imports++,
  });
  document.querySelector("#importMarkdown").click();
  document.querySelector("[data-open-import]").click();
  assert.equal(picks, 2);
  assert.equal(imports, 0);
  input.files = [];
  input.dispatchEvent(new document.defaultView.Event("change"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(imports, 0);
  controls.destroy();
  document.querySelector("#importMarkdown").click();
  assert.equal(picks, 2);
});

test("one native file selection imports once, disables duplicate actions, clears the chooser, and recovers after failure", async () => {
  const { document } = parseHTML(
    '<button id="importMarkdown"></button><button data-open-import></button><input id="markdownFile" type="file">',
  );
  const input = document.querySelector("#markdownFile"),
    errors = [];
  let finish,
    imports = 0;
  connectMarkdownFilePicker(document, {
    onFile: () => {
      imports++;
      return new Promise((resolve, reject) => (finish = reject));
    },
    onError: (error) => errors.push(error.message),
  });
  input.files = [file];
  input.value = "synthetic.md";
  input.dispatchEvent(new document.defaultView.Event("change"));
  assert.equal(document.querySelector("#importMarkdown").disabled, true);
  input.dispatchEvent(new document.defaultView.Event("change"));
  assert.equal(imports, 1);
  finish(new Error("保存失败"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ["保存失败"]);
  assert.equal(input.value, "");
  assert.equal(document.querySelector("#importMarkdown").disabled, false);
});
