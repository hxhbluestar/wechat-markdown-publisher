// The server owns job state. Polling never creates, retries or resolves a job.
const ACTIVE = new Set(["queued", "running"]);
const STATES = {
  queued: "排队中",
  running: "同步中",
  succeeded: "同步成功 · 已完成核对",
  failed: "本次任务未完成",
  uncertain: "结果待核实",
  interrupted: "任务已中断",
};
const STAGES = {
  preflight: "发布前检查",
  images: "正文素材",
  cover: "封面",
  "remote-check": "远端变更检查",
  "remote-write": "写入微信草稿",
  verify: "远端读回核对",
};
const hash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const mediaId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);

export function syncProgressMarkup({entry = true} = {}) {
  return `${entry ? '<button type="button" class="toolbar-button" id="openSyncJobs">同步任务</button>' : ''}
  <dialog class="sync-jobs-dialog" id="syncJobsDialog" aria-labelledby="syncJobsTitle">
    <header><div><small>本机同步记录</small><h2 id="syncJobsTitle">同步任务与远端核对</h2></div><button type="button" id="closeSyncJobs" aria-label="关闭同步任务">×</button></header>
    <div class="sync-jobs-toolbar"><button type="button" data-sync-action="refresh">刷新任务列表</button><span>后台结果以任务记录为准</span></div>
    <div class="sync-jobs-layout"><section id="syncJobList" aria-label="同步任务列表"></section><section id="syncJobDetail" aria-label="当前任务进度"></section></div>
    <footer><span id="syncJobsMessage" role="status" aria-live="polite"></span></footer>
  </dialog>`;
}

/** request uses the app's JSON request(url,{method,body}) convention.
 * watch(job) opens progress and polls active jobs even after the dialog closes.
 * onCompleted fires once per server-succeeded job. It receives that job's frozen
 * identity; the caller must preserve any newer editor input. All retries and
 * uncertain-result resolution require explicit user actions. destroy is final.
 * Optional timers make the single, nonoverlapping 1s poll deterministic in tests.
 */
export function connectSyncProgress(
  document,
  {
    request,
    getDraftId = () => null,
    getAccountId = () => null,
    onCompleted = () => {},
    onSyncWithChoice = () => {},
    toast = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  if (typeof request !== "function")
    throw new TypeError("Sync progress requires a request adapter");
  const query = (selector) => document.querySelector(selector),
    dialog = query("#syncJobsDialog"),
    list = query("#syncJobList"),
    detail = query("#syncJobDetail"),
    message = query("#syncJobsMessage"),
    entry = query("#openSyncJobs");
  if (!dialog || !entry) throw new Error("Sync progress markup is missing");
  let selected = null,
    items = [],
    timer = null,
    epoch = 0,
    listEpoch = 0,
    destroyed = false,
    busy = false,
    comparison = null,
    comparisonContext = null,
    candidates = null,
    candidatesContext = null,
    knownMediaId = "",
    notify = true;
  const completed = new Set();
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const button = (text, action) => {
    const node = element("button", text);
    node.type = "button";
    node.setAttribute("data-sync-action", action);
    return node;
  };
  const note = (text) => element("p", text, "sync-job-note");
  const say = (text) => {
    if (!destroyed) message.textContent = text;
  };
  const fail = (error) => {
    if (!destroyed) {
      const text = error?.message || "暂时无法读取同步状态";
      say(text);
      toast(text, true);
    }
  };
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const show = () => {
    if (!dialog.hasAttribute("open")) {
      if (dialog.showModal) dialog.showModal();
      else dialog.setAttribute("open", "");
    }
  };
  const close = () => {
    if (dialog.close) dialog.close();
    else dialog.removeAttribute("open");
  };
  const unpack = (value) => value?.job ?? value;
  function validate(job) {
    if (
      !job ||
      typeof job.id !== "string" ||
      !job.id ||
      job.id.length > 128 ||
      !Object.hasOwn(STATES, job.state)
    )
      throw new Error("服务器返回了无效的同步任务");
    return job;
  }
  function updateBadge() {
    entry.textContent =
      selected && ACTIVE.has(selected.state)
        ? "同步任务 · 进行中"
        : selected?.state === "uncertain"
          ? "同步任务 · 待核实"
          : "同步任务";
  }
  function renderList() {
    list.replaceChildren();
    if (!items.length) list.append(note("当前范围暂无同步任务。"));
    for (const job of items) {
      const card = element("article", undefined, "sync-job-card"),
        choose = button(job.id, "select");
      choose.setAttribute("data-sync-job-id", job.id);
      choose.setAttribute("aria-pressed", String(selected?.id === job.id));
      card.append(
        choose,
        element(
          "p",
          `${STATES[job.state] || job.state} · ${STAGES[job.stage] || job.stage || ""}`,
        ),
      );
      if (job.error?.message) card.append(note(job.error.message));
      list.append(card);
    }
  }
  function renderComparison() {
    if (!comparison) return;
    const area = element("section", undefined, "sync-remote-comparison");
    area.setAttribute("data-sync-comparison", "");
    area.append(
      element("h3", "微信草稿语义比较"),
      note(
        "比较正文、图片、代码与表格结构；布局属性变化已规范化。以下内容只读。",
      ),
    );
    if (comparison.fields?.length)
      area.append(note("变化字段：" + comparison.fields.join("、")));
    const columns = element("div", undefined, "sync-comparison-columns");
    for (const [label, value] of [
      ["上次核对基线", comparison.baseline],
      ["当前微信草稿", comparison.current],
    ]) {
      const column = element("section");
      column.append(
        element("h4", label),
        element(
          "pre",
          value ? JSON.stringify(value, null, 2) : "暂无可信的对照基线",
        ),
      );
      columns.append(column);
    }
    area.append(columns);
    const actions = element("div", undefined, "sync-job-actions");
    actions.append(button("保留远端并关闭", "keep-remote"));
    if (hash(comparison.current_hash))
      actions.append(
        button("确认覆盖远端（重新预检）", "overwrite"),
        button("复制为新微信草稿（重新预检）", "copy"),
      );
    else area.append(note("远端指纹不可用，无法确认覆盖或复制，请重新核对。"));
    area.append(actions);
    detail.append(area);
  }
  function renderCandidates() {
    if (candidates === null || selected?.state !== "uncertain") return;
    const area = element("section", undefined, "sync-remote-comparison");
    area.setAttribute("data-sync-candidates", "");
    area.append(element("h3", "最近微信草稿（只读）"));
    area.append(
      note(
        "仅检查最近 20 条。匹配任务快照的草稿仍需点击关联，服务器会再次读回核对。",
      ),
    );
    if (!candidates.length)
      area.append(
        note("最近 20 条中未找到候选草稿；可在下方填写已知 media_id 核对。"),
      );
    for (const candidate of candidates) {
      const item = element("article", undefined, "sync-job-card");
      item.append(element("h4", candidate.title || "未命名草稿"));
      item.append(note("更新时间：" + (candidate.update_time ?? "未知")));
      item.append(
        note(
          candidate.matches_snapshot
            ? "与本任务快照匹配"
            : "与本任务快照不匹配，不能关联",
        ),
      );
      const adopt = button("核对并关联此草稿", "adopt");
      adopt.setAttribute("data-sync-media-id", candidate.media_id);
      adopt.disabled =
        !candidate.matches_snapshot || !sameContext(candidatesContext);
      item.append(adopt);
      area.append(item);
    }
    detail.append(area);
  }
  function render() {
    updateBadge();
    detail.replaceChildren();
    if (!selected) {
      detail.append(note("选择任务查看原始快照的进度与核对状态。"));
      return;
    }
    const job = selected;
    detail.append(element("h3", STATES[job.state]), element("code", job.id));
    const completed = job.progress?.completed,
      total = job.progress?.total;
    const progress =
      Number.isInteger(completed) && Number.isInteger(total) && total >= 0
        ? ` · ${completed} / ${total}`
        : "";
    detail.append(
      element(
        "p",
        (STAGES[job.stage] || job.stage || "状态待刷新") + progress,
        "sync-job-stage",
      ),
    );
    if (job.progress?.operation)
      detail.append(
        note(
          job.progress.operation === "create"
            ? "本任务操作：新增微信草稿"
            : "本任务操作：更新已有微信草稿",
        ),
      );
    if (job.error?.message)
      detail.append(element("p", job.error.message, "sync-job-error"));
    if (job.result?.content_sha256)
      detail.append(note("同步快照正文指纹：" + job.result.content_sha256));
    if (job.state === "succeeded")
      detail.append(
        note(
          "此结果只对应本任务接受的原始快照；之后的新输入仍需要保存和重新同步。",
        ),
      );
    const actions = element("div", undefined, "sync-job-actions");
    if (job.state === "failed" || job.state === "interrupted") {
      detail.append(
        note("重试只发送本任务原始快照，不包含此后的正文、排版或素材编辑。"),
      );
      if (job.error?.code === "remote-conflict")
        actions.append(button("比较微信后台改动", "compare"));
      actions.append(button("重试原始快照", "retry"));
    }
    if (job.state === "uncertain") {
      detail.append(
        element(
          "p",
          "结果待核实：不要重建草稿。超时或进程中断不能证明远端没有写入。",
          "sync-job-error",
        ),
      );
      actions.append(button("读回核实已知微信草稿", "verify"));
      actions.append(button("查找最近微信草稿", "candidates"));
      const known = element("label", undefined, "sync-manual-check"),
        input = element("input");
      input.type = "text";
      input.maxLength = 256;
      input.autocomplete = "off";
      input.setAttribute("data-sync-known-media-id", "");
      input.value = knownMediaId;
      input.disabled = busy;
      known.append(
        document.createTextNode(
          "已知微信草稿 media_id（可核对最近 20 条以外的草稿）",
        ),
        input,
      );
      detail.append(known);
      actions.append(button("核对并关联已知 media_id", "verify-manual"));
      const link = element("a", "打开微信公众平台");
      link.href = "https://mp.weixin.qq.com/";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("data-sync-backend-link", "");
      actions.append(link);
      const manual = element("label", undefined, "sync-manual-check"),
        checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("data-sync-not-written", "");
      manual.append(
        checkbox,
        document.createTextNode("我已在后台核实本次没有创建或更新草稿"),
      );
      detail.append(manual);
      const resolve = button("确认未写入，解除待核实状态", "resolve");
      resolve.disabled = true;
      actions.append(resolve);
      detail.append(
        note("解除状态后也不会自动重试；只有再次点击“重试原始快照”才会发送。"),
      );
    }
    detail.append(actions);
    renderCandidates();
    renderComparison();
    if (busy)
      for (const node of detail.querySelectorAll("button"))
        node.disabled = true;
  }
  function finish(job, shouldNotify) {
    if (shouldNotify && job.state === "succeeded" && !completed.has(job.id)) {
      completed.add(job.id);
      Promise.resolve()
        .then(() => {
          if (!destroyed) return onCompleted(job);
        })
        .catch(fail);
    }
  }
  function schedule() {
    cancel();
    if (destroyed || !selected || !ACTIVE.has(selected.state)) return;
    const expected = epoch,
      id = selected.id;
    timer = setTimer(() => {
      timer = null;
      Promise.resolve()
        .then(() => request("/api/editor/sync-jobs/" + encodeURIComponent(id)))
        .then((value) => {
          if (destroyed || epoch !== expected || selected?.id !== id) return;
          const job = validate(unpack(value));
          if (job.id !== id) throw new Error("任务响应编号不匹配");
          listEpoch++;
          selected = job;
          items = items.map((item) => (item.id === id ? job : item));
          say("");
          render();
          renderList();
          finish(job, notify);
        })
        .catch((error) => {
          if (!destroyed && epoch === expected) fail(error);
        })
        .finally(() => {
          if (!destroyed && epoch === expected) schedule();
        });
    }, 1000);
  }
  function select(job, shouldNotify) {
    validate(job);
    cancel();
    epoch++;
    listEpoch++;
    selected = job;
    comparison = comparisonContext = null;
    candidates = candidatesContext = null;
    knownMediaId = "";
    busy = false;
    notify = shouldNotify;
    if (!items.some((item) => item.id === job.id)) items.unshift(job);
    else items = items.map((item) => (item.id === job.id ? job : item));
    say("");
    render();
    renderList();
    schedule();
    finish(job, shouldNotify);
  }
  function watch(job) {
    if (destroyed) return;
    select(job, true);
    show();
  }
  async function open() {
    if (destroyed) return;
    show();
    const draftId = getDraftId(),
      generation = ++listEpoch;
    if (selected && draftId && selected.draft_id !== draftId) {
      cancel();
      epoch++;
      selected = null;
      comparison = comparisonContext = null;
      candidates = candidatesContext = null;
      knownMediaId = "";
      render();
    }
    say("正在读取任务记录…");
    try {
      const response = await request(
        "/api/editor/sync-jobs" +
          (draftId ? "?draft_id=" + encodeURIComponent(draftId) : ""),
      );
      if (destroyed || generation !== listEpoch || getDraftId() !== draftId)
        return;
      if (!Array.isArray(response?.items))
        throw new Error("服务器返回了无效的任务列表");
      items = response.items.map(validate);
      renderList();
      say("");
    } catch (error) {
      if (!destroyed && generation === listEpoch && getDraftId() === draftId)
        fail(error);
    }
  }
  const sameContext = (context) =>
    context &&
    getDraftId() === context.draftId &&
    getAccountId() === context.accountId;
  async function action(name, candidateId) {
    if (destroyed) return;
    if (name === "refresh") return open();
    if (name === "keep-remote") {
      close();
      return;
    }
    if (busy || !selected) return;
    const job = selected,
      expected = epoch;
    if (name === "overwrite" || name === "copy") {
      if (
        !comparison ||
        !hash(comparison.current_hash) ||
        !sameContext(comparisonContext)
      ) {
        say("稿件或账号已切换，请重新比较远端内容。");
        return;
      }
      const choice = {
        remote_action: name,
        expected_remote_hash: comparison.current_hash,
      };
      busy = true;
      render();
      close();
      try {
        await onSyncWithChoice(choice);
      } catch (error) {
        fail(error);
      } finally {
        if (!destroyed && epoch === expected) {
          busy = false;
          render();
        }
      }
      return;
    }
    if (name === "retry" && !["failed", "interrupted"].includes(job.state))
      return;
    if (
      ["verify", "resolve", "candidates", "adopt", "verify-manual"].includes(
        name,
      ) &&
      job.state !== "uncertain"
    )
      return;
    if (
      name === "resolve" &&
      !detail.querySelector("[data-sync-not-written]")?.checked
    )
      return;
    if (
      ![
        "retry",
        "verify",
        "resolve",
        "compare",
        "candidates",
        "adopt",
        "verify-manual",
      ].includes(name)
    )
      return;
    let context;
    const candidateAction = ["candidates", "adopt", "verify-manual"].includes(
      name,
    );
    let verifyMediaId;
    if (name === "compare" || candidateAction) {
      context = {
        draftId: job.draft_id || getDraftId(),
        accountId: job.account_id || getAccountId(),
      };
      if (!sameContext(context)) {
        say("请先选择本任务对应的稿件和公众号，再核对微信后台内容。");
        return;
      }
    }
    if (name === "adopt") {
      const candidate = candidates?.find(
        (item) => item.media_id === candidateId && item.matches_snapshot,
      );
      if (!candidate || !sameContext(candidatesContext)) return;
      verifyMediaId = candidate.media_id;
    }
    if (name === "verify-manual") {
      knownMediaId =
        detail.querySelector("[data-sync-known-media-id]")?.value.trim() || "";
      if (!mediaId(knownMediaId)) {
        say(
          "请填写有效的已知微信草稿 media_id，仅接受字母、数字、下划线或短横线。",
        );
        return;
      }
      verifyMediaId = knownMediaId;
    }
    busy = true;
    render();
    say(
      name === "compare"
        ? "正在读取微信草稿用于比较…"
        : "正在读取服务器核对结果…",
    );
    try {
      let response;
      if (name === "compare")
        response = await request(
          "/api/wechat/drafts/" +
            encodeURIComponent(context.draftId) +
            "/remote-compare",
          {
            method: "POST",
            body: JSON.stringify({ account_id: context.accountId }),
          },
        );
      else
        response = await request(
          "/api/editor/sync-jobs/" +
            encodeURIComponent(job.id) +
            "/" +
            (verifyMediaId ? "verify" : name),
          {
            method: "POST",
            body: JSON.stringify(
              name === "resolve"
                ? { confirmed_not_written: true }
                : verifyMediaId
                  ? { media_id: verifyMediaId }
                  : {},
            ),
          },
        );
      if (destroyed || epoch !== expected || selected?.id !== job.id) return;
      if (candidateAction && !sameContext(context)) {
        say("稿件或账号已切换，已忽略旧的微信草稿核对结果。");
        return;
      }
      if (name === "candidates") {
        if (!Array.isArray(response?.items))
          throw new Error("服务器返回了无效的候选草稿列表");
        // Project known safe fields only. Never display remote HTML or tokens.
        candidates = response.items
          .slice(0, 20)
          .filter((item) => mediaId(item?.media_id))
          .map((item) => ({
            media_id: item.media_id,
            title:
              typeof item.title === "string" ? item.title.slice(0, 512) : "",
            update_time:
              Number.isSafeInteger(item.update_time) && item.update_time >= 0
                ? item.update_time
                : null,
            matches_snapshot: item.matches_snapshot === true,
          }));
        candidatesContext = context;
        say("查找完成。请逐项核对；只有明确点击关联才会提交读回验证。");
        return;
      }
      if (name === "compare") {
        if (!sameContext(context)) {
          say("稿件或账号已切换，已忽略旧的比较结果。");
          return;
        }
        comparison = response;
        comparisonContext = context;
        say("请选择保留远端、覆盖或复制；覆盖和复制会重新执行本地预检。");
      } else {
        const current = validate(unpack(response));
        if (current.id !== job.id) throw new Error("任务响应编号不匹配");
        listEpoch++;
        selected = current;
        comparison = comparisonContext = null;
        if (current.state !== "uncertain")
          candidates = candidatesContext = null;
        items = items.map((item) => (item.id === current.id ? current : item));
        notify = true;
        finish(current, true);
        schedule();
        say(
          ["verify", "adopt", "verify-manual"].includes(name) &&
            current.state !== "succeeded"
            ? "远端结果仍未确认，请继续核对；不会自动重试。"
            : ["verify", "adopt", "verify-manual"].includes(name)
              ? "微信草稿已通过服务器读回核对，并关联到本任务。"
              : name === "resolve"
                ? "已记录你的明确核实结果。需要同步时，请另行点击重试。"
                : "已提交原始快照重试；服务器任务状态将继续更新。",
        );
      }
    } catch (error) {
      if (!destroyed && epoch === expected) fail(error);
    } finally {
      if (!destroyed && epoch === expected) {
        busy = false;
        render();
        renderList();
      }
    }
  }
  const clicked = (event) => {
    const target = event.target.closest?.("button");
    if (!target || target.disabled) return;
    if (target === entry) {
      void open();
      return;
    }
    if (target === query("#closeSyncJobs")) {
      close();
      return;
    }
    if (!dialog.contains(target)) return;
    const name = target.getAttribute("data-sync-action");
    if (name === "select") {
      const job = items.find(
        (item) => item.id === target.getAttribute("data-sync-job-id"),
      );
      if (job) select(job, ACTIVE.has(job.state));
      return;
    }
    if (name) void action(name, target.getAttribute("data-sync-media-id"));
  };
  const changed = (event) => {
    if (event.target.matches?.("[data-sync-known-media-id]"))
      knownMediaId = event.target.value;
    if (event.target.matches?.("[data-sync-not-written]")) {
      const resolve = detail.querySelector('[data-sync-action="resolve"]');
      if (resolve) resolve.disabled = busy || !event.target.checked;
    }
  };
  document.addEventListener("click", clicked);
  dialog.addEventListener("change", changed);
  dialog.addEventListener("input", changed);
  render();
  renderList();
  return {
    watch,
    open,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      epoch++;
      listEpoch++;
      cancel();
      document.removeEventListener("click", clicked);
      dialog.removeEventListener("change", changed);
      dialog.removeEventListener("input", changed);
    },
  };
}
