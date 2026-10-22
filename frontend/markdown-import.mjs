// Markdown already is the editor's native format: no conversion or review step.
// Save the visible generation before either creating or switching articles.
export function createMarkdownImporter({
  getDraftId,
  isDirty,
  readFile,
  saveDraft,
  createDraft,
  refreshDrafts,
  openDraft,
}) {
  return async function importMarkdown(file) {
    if (!/\.(?:md|markdown)$/i.test(file?.name || ""))
      throw new Error(
        "请选择 Markdown（.md 或 .markdown）文件；其他格式可在创作工具中导入",
      );
    const originalId = getDraftId();
    const ensureCurrent = () => {
      if (getDraftId() !== originalId)
        throw new Error("稿件已切换，请重新选择 Markdown 文件");
    };
    const saveVisible = async () => {
      if (
        isDirty() &&
        (!(await saveDraft("before-markdown-import")) || isDirty())
      )
        throw new Error("当前修改保存失败，请先保存后再导入");
      ensureCurrent();
    };

    const content = await readFile(file);
    ensureCurrent();
    await saveVisible();
    const draft = await createDraft(content, file.name);
    await refreshDrafts();
    // A deliberate article switch during the request should remain visible.
    if (getDraftId() !== originalId) return { draft, opened: false };
    try {
      await saveVisible();
      await openDraft(draft.id, { preserveChanges: true });
    } catch (error) {
      throw new Error(
        "新稿已导入，当前修改尚未保存；请保存后从稿件列表打开新稿",
        { cause: error },
      );
    }
    return { draft, opened: true };
  };
}

export function connectMarkdownFilePicker(doc, { onFile, onError = () => {} }) {
  const input = doc.querySelector("#markdownFile"),
    entries = [...doc.querySelectorAll("#importMarkdown, [data-open-import]")];
  let busy = false;
  const choose = () => {
    if (!busy) input.click();
  };
  const changed = async () => {
    const file = input.files?.[0];
    if (busy || !file) return;
    busy = true;
    const previousDisabled = entries.map((entry) => entry.disabled);
    for (const entry of entries) entry.disabled = true;
    try {
      await onFile(file);
    } catch (error) {
      onError(error);
    } finally {
      input.value = "";
      busy = false;
      entries.forEach((entry, index) => {
        entry.disabled = previousDisabled[index];
      });
    }
  };
  for (const entry of entries) entry.addEventListener("click", choose);
  input.addEventListener("change", changed);
  return {
    destroy() {
      for (const entry of entries) entry.removeEventListener("click", choose);
      input.removeEventListener("change", changed);
    },
  };
}
