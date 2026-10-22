import { analyzeArticle } from "./article-preflight.mjs";
import {
  CONTENT_TEMPLATES,
  EXPERIMENT_FIELDS,
  createContentTemplate,
  createTitleCandidates,
} from "./technical-writing.mjs";

const PANES = [
  ["recovery", "自动恢复"],
  ["history", "版本历史"],
  ["trash", "回收站"],
  ["import", "导入工作台"],
  ["preflight", "发布检查"],
  ["technical", "技术写作"],
];
export function workflowMarkup({ preflightEntry = true } = {}) {
  return `<button type="button" class="toolbar-button" id="openWorkflow">创作工具<span id="recoveryCount"></span></button>${preflightEntry ? '<button type="button" class="toolbar-button" id="openPreflight">发布检查</button>' : ""}
<dialog id="workflowDialog" class="workflow-dialog"><header><div><small>本机创作工作台</small><h2 id="workflowTitle">创作工具</h2></div><button type="button" id="closeWorkflow" aria-label="关闭创作工具">×</button></header><nav>${PANES.map(([id, label]) => `<button type="button" data-workflow-pane="${id}">${label}</button>`).join("")}</nav><div id="workflowBody" class="workflow-body"></div><footer><span id="workflowMessage" role="status"></span><button type="button" id="workflowRecheck" hidden disabled>重新检查</button></footer></dialog>
<dialog id="conflictDialog" class="workflow-dialog"><header><h2>保存冲突 · 当前输入已保留</h2><button type="button" id="closeConflict">关闭</button></header><p>另一个窗口更新了稿件。比较后可另存副本，原稿不会被覆盖。</p><div class="workflow-compare"><section><h3>当前输入</h3><pre id="conflictLocal"></pre></section><section><h3>后端已保存版本</h3><pre id="conflictRemote"></pre></section></div><footer><button type="button" id="saveConflictCopy">另存为新副本</button></footer></dialog>`;
}

export function connectWorkflowUI(doc, a) {
  const $ = (s) => doc.querySelector(s),
    dialog = $("#workflowDialog"),
    body = $("#workflowBody"),
    message = $("#workflowMessage"),
    recheck = $("#workflowRecheck");
  let pane = "recovery",
    pendingUpload = null,
    conflict = null,
    conflictBusy = false,
    destroyed = false,
    viewGeneration = 0;
  const listeners = [];
  const on = (node, event, fn) => {
    node.addEventListener(event, fn);
    listeners.push(() => node.removeEventListener(event, fn));
  };
  const el = (tag, text, classes) => {
    const n = doc.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (classes) n.className = classes;
    return n;
  };
  const button = (text, action) => {
    const n = el("button", text);
    n.type = "button";
    n.addEventListener("click", () => {
      if (!destroyed) Promise.resolve().then(action).catch(fail);
    });
    return n;
  };
  const fail = (e) => {
    if (destroyed) return;
    message.textContent = e?.message || String(e);
    a.toast?.(message.textContent, true);
  };
  const note = (text) => body.append(el("p", text, "workflow-note"));
  const card = (title, subtitle) => {
    const n = el("article", undefined, "workflow-card");
    n.append(el("h3", title), el("p", subtitle));
    body.append(n);
    return n;
  };
  const current = () => {
    const d = a.getDraft();
    if (!d) throw new Error("请先选择稿件");
    return d;
  };
  const active = (ticket, expectedPane) =>
    !destroyed &&
    viewGeneration === ticket &&
    (!expectedPane || pane === expectedPane);
  function invalidate() {
    viewGeneration++;
    body.onchange = null;
    recheck.hidden = true;
    recheck.disabled = true;
  }
  function close() {
    invalidate();
    dialog.close();
  }
  async function open(id = "recovery") {
    if (destroyed) return;
    const ticket = ++viewGeneration;
    pane = id;
    body.onchange = null;
    message.textContent = "";
    recheck.hidden = true;
    recheck.disabled = true;
    body.replaceChildren();
    $("#workflowTitle").textContent =
      PANES.find((p) => p[0] === id)?.[1] || "创作工具";
    for (const b of dialog.querySelectorAll("[data-workflow-pane]"))
      b.classList.toggle("is-active", b.dataset.workflowPane === id);
    if (!dialog.hasAttribute("open")) dialog.showModal();
    try {
      await (
        {
          recovery: renderRecovery,
          history: renderHistory,
          trash: renderTrash,
          import: renderImport,
          preflight: renderCheck,
          technical: renderTechnical,
        }[id] || renderRecovery
      )(ticket);
    } catch (e) {
      if (active(ticket, id)) {
        recheck.disabled = true;
        fail(e);
      }
    }
  }
  async function refreshRecoveryCount() {
    try {
      const records = await a.recovery.list();
      if (!destroyed)
        $("#recoveryCount").textContent = records.length
          ? ` · 可恢复 ${records.length}`
          : "";
    } catch (e) {
      a.onRecoveryError?.(e);
    }
  }
  async function renderRecovery(ticket) {
    note(
      "自动暂存仅写入本机浏览器。闲置约 1 秒、持续输入约 2 秒安排写入；成功落盘前的最后输入仍可能丢失。恢复后请保存或另存副本。",
    );
    const records = await a.recovery.list();
    if (!active(ticket, "recovery")) return;
    if (!records.length)
      note("没有待恢复记录。已成功保存的同一版本会自动清除暂存。");
    for (const r of records) {
      const n = card(
        r.metadata.title || "未命名文章",
        new Date(r.updatedAt).toLocaleString("zh-CN"),
      );
      n.append(
        button("查看差异", async () => {
          const local = await a.recovery.read(r.recoveryId || r.id);
          let saved = null;
          try {
            saved = await a.request(
              `/api/editor/drafts/${encodeURIComponent(r.id)}`,
            );
          } catch {}
          showComparison(local, saved);
        }),
        button("恢复到编辑区", async () => {
          await a.restoreLocal(await a.recovery.read(r.recoveryId || r.id));
          close();
        }),
        button("清除此恢复记录", async () => {
          await a.recovery.discard(r.recoveryId || r.id);
          await refreshRecoveryCount();
          await renderAgain();
        }),
      );
    }
  }
  async function renderHistory(ticket) {
    const d = current();
    note(
      "每次手工保存前保留原版本；恢复旧版先保存当前内容，并创建新稿副本。素材按哈希保存原件。",
    );
    const result = await a.request(
      `/api/editor/drafts/${encodeURIComponent(d.id)}/history`,
    );
    if (!active(ticket, "history") || a.getDraft()?.id !== d.id) return;
    const exportButton = button(
      "导出文章包（Markdown、原图、设置、同步清单）",
      () => a.downloadPackage(d.id),
    );
    body.append(exportButton);
    if (!result.items.length) note("尚无历史版本。第一次保存后会出现。");
    for (const v of result.items) {
      const n = card(
        v.title || "未命名文章",
        `${new Date(v.created_at).toLocaleString("zh-CN")} · ${v.reason} · ${v.asset_count} 张素材`,
      );
      const path = `/api/editor/drafts/${encodeURIComponent(d.id)}/history/${encodeURIComponent(v.snapshot_id)}`;
      n.append(
        button("比较正文与设置", async () => {
          const old = await a.request(path);
          showComparison(
            { content: a.getContent(), metadata: a.getMetadata() },
            old,
          );
        }),
        button("恢复为新副本", async () => {
          await a.beforeImport();
          const live = current();
          if (live.id !== d.id) throw new Error("稿件已切换，请重新选择版本");
          const r = await a.request(path + "/restore", {
            method: "POST",
            body: JSON.stringify({ revision: live.revision }),
          });
          await a.onImported(r.draft);
          close();
        }),
      );
    }
    const source = await a
      .request(`/api/editor/drafts/${encodeURIComponent(d.id)}/import-report`)
      .catch(() => null);
    if (
      active(ticket, "history") &&
      a.getDraft()?.id === d.id &&
      source?.report
    ) {
      const n = card("导入原稿与质量报告", source.source?.filename || "");
      n.append(el("pre", JSON.stringify(source.report, null, 2)));
      if (source.original_text) n.append(el("pre", source.original_text));
    }
  }
  function showComparison(local, remote) {
    const area = el("div", undefined, "workflow-compare");
    for (const [label, value] of [
      ["当前 / 恢复记录", local],
      ["对照版本", remote],
    ]) {
      const n = el("section");
      n.append(
        el("h3", label),
        el(
          "pre",
          value
            ? value.content + "\n\n" + JSON.stringify(value.metadata, null, 2)
            : "后端版本不可用；暂存内容仍然保留",
        ),
      );
      area.append(n);
    }
    body.append(area);
  }
  async function renderTrash(ticket) {
    note(
      "删除的稿件和完整原图保存在本机回收站。默认保留提示为 30 天，不会自动永久清理。",
    );
    const result = await a.request("/api/editor/trash");
    if (!active(ticket, "trash")) return;
    if (!result.items.length) note("回收站为空。");
    for (const r of result.items) {
      const n = card(
        r.title || r.draft_id,
        `${new Date(r.deleted_at || r.created_at).toLocaleString("zh-CN")} · 清理提示 ${r.cleanup_after || ""}`,
      );
      let cleaning = false;
      n.append(
        button("恢复原稿与素材", async () => {
          const result = await a.request(
            `/api/editor/trash/${encodeURIComponent(r.trash_id)}/restore`,
            { method: "POST", body: "{}" },
          );
          await a.onRestored?.(result.draft);
          if (active(ticket, "trash")) await renderAgain();
        }),
        button("永久清理（不可恢复）", async () => {
          if (cleaning || !active(ticket, "trash")) return;
          cleaning = true;
          try {
            const warning = `永久删除回收站中的《${r.title || r.draft_id}》及全部图片原件。此操作不可恢复，无法再从回收站找回。确定永久清理吗？`;
            const confirmed = a.confirmPermanent
              ? await a.confirmPermanent(warning, r)
              : doc.defaultView?.confirm?.call(doc.defaultView, warning);
            if (!confirmed || !active(ticket, "trash")) return;
            await a.request(
              `/api/editor/trash/${encodeURIComponent(r.trash_id)}`,
              {
                method: "DELETE",
                body: JSON.stringify({ confirmation: r.trash_id }),
              },
            );
            if (active(ticket, "trash")) await renderAgain();
          } finally {
            cleaning = false;
          }
        }),
      );
    }
  }
  function renderImport() {
    note(
      "先转换并核对数量，再确认生成新稿。支持 Markdown、含一篇 Markdown 与配图的 ZIP、DOCX；复杂合并单元格与公式会列入报告。网络图片需另行下载。",
    );
    const file = el("input");
    file.type = "file";
    file.accept = ".md,.markdown,.zip,.docx";
    file.id = "workbenchFile";
    body.append(file);
    file.addEventListener("change", async () => {
      if (!file.files?.[0]) return;
      try {
        const f = file.files[0];
        pendingUpload = { filename: f.name, data: await base64File(f) };
        await previewImport();
      } catch (e) {
        fail(e);
      }
    });
    const source = el("input");
    source.type = "url";
    source.placeholder = "原网页 URL（选填，用于相对链接和署名）";
    source.id = "htmlImportSource";
    const html = el("textarea");
    html.rows = 7;
    html.placeholder = "在此明确粘贴网页 HTML 源码；脚本和交互组件会移除";
    html.id = "htmlImportText";
    body.append(
      el("h3", "网页 HTML 粘贴"),
      source,
      html,
      button("预检 HTML 转换", async () => {
        pendingUpload = {
          filename: "pasted.html",
          kind: "html",
          source_url: source.value,
          data: bytesBase64(new TextEncoder().encode(html.value)),
        };
        await previewImport();
      }),
    );
    const result = el("div");
    result.id = "importResult";
    body.append(result);
  }
  async function previewImport() {
    message.textContent = "正在本机转换并核对素材…";
    const r = await a.request("/api/editor/import", {
      method: "POST",
      body: JSON.stringify({ ...pendingUpload, preview_only: true }),
    });
    const target = $("#importResult");
    target.replaceChildren(el("h3", r.title || "转换报告"));
    const counts = r.report;
    target.append(
      el(
        "p",
        `转换前：${counts.before.images} 图 / ${counts.before.fences} 代码块 / ${counts.before.tables} 表格；转换后：${counts.after.images} 图 / ${counts.after.fences} 代码块 / ${counts.after.tables} 表格。`,
      ),
    );
    for (const text of [...counts.conversions, ...counts.warnings])
      target.append(el("p", text));
    const compare = el("details");
    compare.append(
      el("summary", "查看转换后的 Markdown"),
      el("pre", r.preview_content || ""),
    );
    target.append(compare);
    let duplicateCheck = null;
    if (r.duplicates?.length) {
      const label = el("label");
      duplicateCheck = el("input");
      duplicateCheck.type = "checkbox";
      label.append(
        duplicateCheck,
        el(
          "span",
          `相同来源 / 内容已有 ${r.duplicates.length} 稿；我确认另建版本副本`,
        ),
      );
      target.append(label);
    }
    target.append(
      button("确认导入为新稿", async () => {
        if (duplicateCheck && !duplicateCheck.checked)
          throw new Error("请先确认重复导入为新版本副本");
        await a.beforeImport();
        const result = await a.request("/api/editor/import", {
          method: "POST",
          body: JSON.stringify({
            ...pendingUpload,
            allow_duplicate: !!duplicateCheck?.checked,
          }),
        });
        await a.onImported(result.draft);
        close();
        a.toast?.("导入完成，质量报告与原稿已保存在版本工作台");
      }),
    );
    message.textContent = "转换完成，请核对后确认导入。";
  }
  function snapshot() {
    const draft = current(),
      metadata = JSON.parse(JSON.stringify(a.getMetadata() || {}));
    return {
      draftId: draft.id,
      revision: draft.revision,
      content: a.getContent(),
      metadata,
      renderVersion: a.getRenderVersion?.() || "",
      accountId: metadata.wechat_account_id || a.getAccountId?.() || "",
    };
  }
  function fresh(value) {
    try {
      const live = snapshot();
      return (
        ["draftId", "revision", "content", "renderVersion", "accountId"].every(
          (key) => live[key] === value[key],
        ) && canonical(live.metadata) === canonical(value.metadata)
      );
    } catch {
      return false;
    }
  }
  function requireFresh(value) {
    if (!fresh(value))
      throw new Error(
        "稿件、内容、设置、公众号或排版器已经变化，请保存后重新检查",
      );
  }
  async function collectCheck(ticket) {
    const id = current().id;
    message.textContent = "正在保存当前修改并生成发布检查…";
    await a.beforeImport?.();
    if (!active(ticket, "preflight")) return;
    if (current().id !== id) throw new Error("稿件已切换，请重新检查");
    const saved = snapshot();
    message.textContent = "正在本机检查正文、设置、素材与排版…";
    const html = await a.getHtml();
    if (!active(ticket, "preflight")) return;
    requireFresh(saved);
    const ignored =
      typeof a.ignoredWords === "function"
        ? a.ignoredWords()
        : a.ignoredWords || [];
    const ignoredWords =
      Array.isArray(ignored) || ignored instanceof Set
        ? [...ignored].filter((value) => typeof value === "string")
        : [];
    const local = analyzeArticle({
      content: saved.content,
      metadata: saved.metadata,
      assets: a.getAssets(),
      html,
      draftId: saved.draftId,
      ignoredWords,
    });
    let remote;
    try {
      remote = await a.request(
        `/api/editor/drafts/${encodeURIComponent(saved.draftId)}/preflight`,
        {
          method: "POST",
          body: JSON.stringify({
            html,
            render_version: saved.renderVersion,
            account_id: saved.accountId,
          }),
        },
      );
    } catch (e) {
      remote = {
        issues: [
          {
            id: "server-unavailable",
            code: "server-unavailable",
            severity: "blocker",
            field: "settings",
            message: "服务端预检未完成：" + e.message,
          },
        ],
        fingerprint: "",
      };
    }
    if (!active(ticket, "preflight")) return;
    requireFresh(saved);
    if (!Array.isArray(remote?.issues))
      throw new Error("服务端预检报告无效，请重新检查");
    const invalid =
      !/^[a-f0-9]{64}$/.test(remote.fingerprint || "") &&
      !remote.issues.some((issue) => issue.severity === "blocker");
    const issues = [...local.issues, ...remote.issues];
    if (invalid)
      issues.push({
        id: "server-fingerprint-invalid",
        code: "server-fingerprint-invalid",
        severity: "blocker",
        field: "settings",
        message: "服务端未提供有效的版本指纹，不能继续同步",
      });
    return { value: { ...remote, html, issues }, saved };
  }
  async function renderCheck(ticket) {
    const checked = await collectCheck(ticket);
    if (checked)
      await showReport(checked.value, { saved: checked.saved, ticket });
  }
  async function showReport(value, options = {}) {
    if (destroyed) return;
    const ticket = options.ticket ?? ++viewGeneration;
    if (options.ticket === undefined) pane = "preflight";
    if (!active(ticket, "preflight")) return;
    $("#workflowTitle").textContent = "发布检查";
    for (const b of dialog.querySelectorAll("[data-workflow-pane]"))
      b.classList.toggle("is-active", b.dataset.workflowPane === "preflight");
    const groups = [],
      deduplicated = new Map();
    for (const original of value.issues) {
      const issue = {
        ...original,
        severity: original.severity === "confirm" ? "info" : original.severity,
      };
      const key =
        typeof issue.code === "string"
          ? JSON.stringify([
              issue.severity,
              issue.code,
              issue.field,
              issue.from,
              issue.to,
            ])
          : null;
      if (key && deduplicated.has(key)) {
        deduplicated.get(key).issues.push(issue);
        continue;
      }
      const group = { issue, issues: [issue] };
      groups.push(group);
      if (key) deduplicated.set(key, group);
    }
    body.replaceChildren();
    recheck.hidden = false;
    recheck.disabled = false;
    const counts = { blocker: 0, info: 0 };
    for (const { issue } of groups) counts[issue.severity]++;
    note(
      `阻断 ${counts.blocker} · 建议 ${counts.info}。建议仅供参考，不影响同步到草稿箱。`,
    );
    for (const group of groups) {
      const issue = group.issue,
        row = el("article", undefined, "workflow-issue " + issue.severity);
      const messages = [
        ...new Set(group.issues.map((item) => item.message)),
      ].join("；");
      row.append(
        el(
          "strong",
          (issue.severity === "blocker" ? "阻断" : "建议") + " · " + messages,
        ),
      );
      if (
        Number.isInteger(issue.from) ||
        [
          "title",
          "digest",
          "source_url",
          "assets",
          "account",
          "cover",
        ].includes(issue.field)
      )
        row.append(button("定位", () => a.selectIssue?.(issue)));
      body.append(row);
    }
    message.textContent = counts.blocker
      ? "请修复阻断项后重新同步；建议不影响同步。"
      : "建议不影响同步到草稿箱，可关闭报告后直接同步。";
  }
  function renderTechnical() {
    const d = current(),
      metadata = a.getMetadata();
    note(
      "内容结构与实验条件使用本地规则。新模板创建新稿；不执行文章命令，不填入虚构实测结果。",
    );
    const type = el("select");
    type.id = "contentType";
    for (const item of CONTENT_TEMPLATES) {
      const option = el("option", item.label);
      option.value = item.id;
      type.append(option);
    }
    type.value = metadata.article_type || "tutorial";
    body.append(
      type,
      button("用此结构创建新稿", async () => {
        await a.beforeImport();
        const result = createContentTemplate(type.value, {
          author: metadata.author || "",
          source_url: metadata.source_url || "",
        });
        await a.createTemplate(result);
        close();
      }),
    );
    body.append(
      button("标记当前文章类型", () =>
        a.applyMetadata({ article_type: type.value }),
      ),
      el("h3", "三个可编辑的标题候选"),
    );
    const candidates = el("div");
    body.append(candidates);
    const updateTitles = () => {
      candidates.replaceChildren();
      for (const title of createTitleCandidates(type.value, {
        ...a.getMetadata(),
        topic: a.getMetadata().title,
      })) {
        candidates.append(button(title, () => a.applyMetadata({ title })));
      }
    };
    type.addEventListener("change", updateTitles);
    updateTitles();
    const grid = el("div", undefined, "workflow-fields");
    for (const f of EXPERIMENT_FIELDS) {
      const label = el("label", f.label);
      const input = el("input");
      input.value = metadata.experiment_conditions?.[f.key] || "";
      input.placeholder = "作者填写 / 不适用";
      input.addEventListener("change", () =>
        a.applyMetadata({
          experiment_conditions: {
            ...(a.getMetadata().experiment_conditions || {}),
            [f.key]: input.value,
          },
        }),
      );
      label.append(input);
      grid.append(label);
    }
    body.append(
      el("h3", "实验与复现条件"),
      grid,
      button("插入当前条件信息块", () => {
        const conditions = a.getMetadata().experiment_conditions || {};
        a.insertMarkdown(
          "## 环境与复现条件\n\n| 条件 | 记录 |\n| --- | --- |\n" +
            EXPERIMENT_FIELDS.map(
              (f) =>
                `| ${f.label} | ${String(conditions[f.key] || "待补充")
                  .replaceAll("|", "\\|")
                  .replaceAll("\n", " ")} |`,
            ).join("\n"),
        );
      }),
    );
    body.append(button("导出文章包", () => a.downloadPackage(d.id)));
  }
  const renderAgain = () => open(pane);
  function conflictSave(error, local) {
    if (error.status !== 409) return;
    conflict = local;
    $("#saveConflictCopy").disabled = conflictBusy;
    $("#conflictLocal").textContent =
      local.content + "\n\n" + JSON.stringify(local.metadata, null, 2);
    $("#conflictRemote").textContent = "正在读取…";
    if (!$("#conflictDialog").hasAttribute("open"))
      $("#conflictDialog").showModal();
    a.request(`/api/editor/drafts/${encodeURIComponent(local.id)}`)
      .then((r) => {
        if (!destroyed && conflict === local)
          $("#conflictRemote").textContent =
            r.content + "\n\n" + JSON.stringify(r.metadata, null, 2);
      })
      .catch(() => {
        if (!destroyed && conflict === local)
          $("#conflictRemote").textContent = "后端版本不可用。当前输入仍保留。";
      });
  }
  on($("#openWorkflow"), "click", () => open("recovery"));
  on($("#openPreflight"), "click", () => open("preflight"));
  on($("#closeWorkflow"), "click", close);
  on(dialog, "cancel", invalidate);
  on(dialog, "close", invalidate);
  for (const b of dialog.querySelectorAll("[data-workflow-pane]"))
    on(b, "click", () => open(b.dataset.workflowPane));
  on(recheck, "click", () => open("preflight"));
  on($("#closeConflict"), "click", () => $("#conflictDialog").close());
  on($("#saveConflictCopy"), "click", async () => {
    if (!conflict || conflictBusy || destroyed) return;
    const local = conflict;
    conflictBusy = true;
    $("#saveConflictCopy").disabled = true;
    try {
      const result = await a.request(
        `/api/editor/drafts/${encodeURIComponent(local.id)}/copy`,
        { method: "POST", body: JSON.stringify(local) },
      );
      if (destroyed) return;
      if (a.onConflictCopy) await a.onConflictCopy(result.draft, local);
      else await a.onImported(result.draft);
      if (!destroyed && conflict === local) $("#conflictDialog").close();
      a.toast?.("当前输入已另存副本");
    } catch (error) {
      fail(error);
    } finally {
      conflictBusy = false;
      if (!destroyed) $("#saveConflictCopy").disabled = false;
    }
  });
  refreshRecoveryCount();
  return {
    open,
    showReport,
    refresh: refreshRecoveryCount,
    conflictSave,
    prepareSync: async () => {
      if (destroyed) return null;
      const ticket = ++viewGeneration;
      pane = "preflight";
      recheck.hidden = true;
      recheck.disabled = true;
      const checked = await collectCheck(ticket);
      if (!checked || !active(ticket, "preflight")) return null;
      requireFresh(checked.saved);
      if (checked.value.issues.some((issue) => issue.severity === "blocker")) {
        await showReport(checked.value, { saved: checked.saved, ticket });
        if (active(ticket, "preflight") && !dialog.hasAttribute("open"))
          dialog.showModal();
        return null;
      }
      const advice = checked.value.issues.filter(
        (issue) => issue.severity !== "blocker",
      ).length;
      if (advice)
        a.toast?.(
          `有 ${advice} 条建议，可在发布检查中查看；已继续同步。`,
          false,
        );
      return { ...checked.value, acknowledged: [] };
    },
    destroy() {
      if (destroyed) return;
      invalidate();
      destroyed = true;
      for (const off of listeners) off();
    },
  };
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function bytesBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 32768)
    text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}
async function base64File(file) {
  if (file.size > 12 * 1024 * 1024) throw new Error("导入文件不能超过 12MiB");
  return bytesBase64(new Uint8Array(await file.arrayBuffer()));
}
