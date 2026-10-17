import { createDraftSaver } from "./draft-save.mjs";
import {
  createRecoveryController,
  createIndexedDBRecoveryStore,
} from "./draft-recovery.mjs";
import { workflowMarkup, connectWorkflowUI } from "./workflow-ui.mjs";
import {
  authoringToolsMarkup,
  connectAuthoringTools,
} from "./authoring-tools.mjs";
import { createCodeFolding } from "./code-folding.mjs";
import { renderRichContent } from "./rich-content.mjs";
import { loadRichRuntime } from "./rich-runtime.mjs";
import {
  renderMarkdownSource,
  lexArticleMarkdown,
} from "./renderer-adapter.mjs";
import {
  StateField,
  StateEffect,
  WidgetType,
} from "./vendor/editor-engine-20261018.js";
import { syncProgressMarkup, connectSyncProgress } from "./sync-progress.mjs";
import { assetToolsMarkup, connectAssetTools } from "./asset-tools.mjs";
import {
  prepareTypography,
  typographyAccent,
  escapeHtmlAttribute,
} from "./typography.mjs";
import {
  proofreadingMarkup,
  connectProofreading,
  createProofreadingExtension,
} from "./proofreading.mjs";
import { scrollSyncMarkup, connectScrollSync } from "./scroll-sync.mjs";
import {
  connectTypographyControls,
  typographyControlsMarkup,
  themeOptionsMarkup,
} from "./typography-controls.mjs";
import { connectRocmImport, rocmImportMarkup } from "./rocm-import.mjs";
import {
  canonicalAssetPath,
  imageUploadTarget,
  missingImagePaths,
} from "./asset-paths.mjs";
import {
  AS as MarkdownLexer,
  kd as markdownRenderer,
  ql as palettes,
  xf as isRemoteImage,
  yf as assetBasename,
  We as EditorView,
  dt as EditorState,
  rs as ViewPlugin,
  Bt as Decoration,
  Tw as history,
  nc as keymap,
  xk as defaultKeymap,
  Iw as historyKeymap,
  yk as tabKeyBinding,
  V5 as markdownExtensions,
  C3 as placeholder,
  u6 as inferTitle,
  o6 as readMarkdownFile,
  n6,
  Fo,
  t6,
  r6,
  ZT as legacyUnderscore,
  l6 as legacyA,
  Uo as legacyG,
  Et as legacyK,
} from "./vendor/editor-engine-20261018.js";
import {
  previewWechatArticle,
  exportWechatArticle,
} from "./renderer-adapter.mjs";
function assetUrl(t, e) {
  if (!t || /^(?:https?:|data:|blob:|\/\/)/i.test(e)) return e;
  const n = canonicalAssetPath(e, t);
  return n.startsWith("/") || n.split("/").includes("..")
    ? e
    : `/api/editor/drafts/${encodeURIComponent(t)}/assets/${n.split("/").map(encodeURIComponent).join("/")}`;
}
function replaceAssetUrls(t, e) {
  return t.replace(
    /(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi,
    (n, r, i, s) => `${r}${assetUrl(e, i)}${s}`,
  );
}
function imageReferences(text) {
  return [
    ...new Set(
      [
        ...text.matchAll(
          /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g,
        ),
      ].map((m) => canonicalAssetPath(m[1] || m[2] || "", state.current?.id)),
    ),
  ];
}
const state = {
  config: null,
  drafts: [],
  assets: [],
  accounts: [],
  current: null,
  editor: null,
  dirty: !1,
  previewTimer: 0,
  previewMode: "wechat",
  theme: "technical",
  palette: "warm",
  sourceMode: "content",
  archive: null,
  archiveTimer: 0,
  archiveSetupVisible: !1,
  pendingDeleteDraftId: "",
};
document.querySelector("#app").innerHTML = `
  <div class="editor-shell">
    <aside class="draft-sidebar">
      <a class="editor-brand" href="/"><img src="/logo.png" alt="" width="42" height="42"><span><strong>星河炸鸡</strong><small>Markdown 创作</small></span></a>
      <div class="sidebar-actions">
        <button class="primary-action" id="newDraft" type="button">＋ 新建文章</button>
        <button class="quiet-action" id="importMarkdown" type="button">导入文章</button>
${rocmImportMarkup()}
        <input id="markdownFile" type="file" accept=".md,.markdown,text/markdown,text/plain" hidden>
      </div>
      <button class="wechat-config-entry needs-binding" id="wechatConfigEntry" type="button">
        <span class="wechat-entry-icon">公众号</span>
        <span class="wechat-entry-copy"><strong id="wechatEntryTitle">绑定微信公众号</strong><small id="wechatEntryMeta">未配置 · 点击开始</small></span>
        <span class="wechat-entry-arrow">›</span>
      </button>
      <button class="archive-entry" id="archiveEntry" type="button">
        <span class="archive-entry-icon">归档</span>
        <span class="wechat-entry-copy"><strong id="archiveEntryTitle">一键归档公众号</strong><small id="archiveEntryMeta">扫码下载文章与素材</small></span>
        <span class="wechat-entry-arrow">›</span>
      </button>
      <div class="draft-list-heading"><span>本地稿件</span><span id="draftCount">0</span></div>
      <div class="draft-list" id="draftList"></div>
      <div class="sidebar-foot"><span class="local-dot"></span>稿件仅保存在本机</div>
    </aside>

    <main class="editor-workspace">
      <header class="editor-toolbar">
        <div class="toolbar-title">
          <button class="mobile-drafts" id="toggleDrafts" type="button" aria-label="打开稿件列表">☰</button>
          <div><small id="saveState">尚未选择稿件</small><small id="recoveryState" aria-live="polite"></small><strong id="currentTitle">创作区</strong></div>
        </div>
        <div class="toolbar-actions">
${workflowMarkup()}
${syncProgressMarkup()}
          <button class="toolbar-button" id="saveDraft" type="button" disabled>保存</button>
${proofreadingMarkup()}
          <button class="sync-button" id="syncDraft" type="button" disabled>同步到草稿箱</button>
          <button class="publish-button" id="publishDraft" type="button" disabled>确认发布</button>
        </div>
      </header>
      <div class="service-warning" id="serviceWarning" hidden>
        <strong>编辑服务未连接</strong>
        <span>请关闭旧发布器服务，重新运行本机发布器启动程序，然后刷新本页。</span>
      </div>

      <section class="empty-editor" id="emptyEditor">
        <span>✦</span><h1>写好的 Markdown，直接在这里完成排版与发布。</h1>
        <p>导入文档或新建文章，历史归档不会被修改。</p>
        <button class="primary-action" type="button" data-open-import>选择 Markdown</button>
      </section>

      <section class="compose-grid" id="composeGrid" hidden>
        <div class="source-panel">
          <div class="source-tabs" role="tablist" aria-label="编辑工作区">
            <div>
              <button class="is-active" type="button" role="tab" aria-selected="true" data-source-mode="content">正文</button>
              <button type="button" role="tab" aria-selected="false" data-source-mode="settings">文章设置</button>
              <button type="button" role="tab" aria-selected="false" data-source-mode="assets">图片素材 <span id="assetCount">0</span></button>
            </div>
            <small id="wordCount">0 字</small>
          </div>

          <div class="source-pane content-pane" data-source-pane="content">
            <div class="source-editor" id="sourceEditor"></div>
          </div>

          <div class="source-pane settings-pane" data-source-pane="settings" hidden>
            <div class="pane-intro"><strong>文章设置</strong><p>这些信息用于公众号草稿，不会写进 Markdown 正文。</p></div>
            <div class="metadata-grid">
              <label class="wide"><span>标题</span><input id="metaTitle" maxlength="64" placeholder="文章标题"></label>
              <label class="wide"><span>作者</span><input id="metaAuthor" maxlength="32" placeholder="作者名"></label>
              <label class="wide"><span>摘要</span><textarea id="metaDigest" maxlength="120" rows="3" placeholder="留空时自动从正文提取"></textarea></label>
              <label class="wide"><span>原文链接</span><input id="metaSource" type="url" placeholder="可选"></label>
              <label class="check"><input id="metaComment" type="checkbox"><span>开启留言</span></label>
              <label class="check"><input id="metaFansComment" type="checkbox"><span>仅关注者留言</span></label>
            </div>
          </div>

          <div class="source-pane assets-pane" data-source-pane="assets" hidden>
            <div class="asset-toolbar">
              <div><strong>图片素材</strong><small>上传后自动保存在当前稿件目录</small></div>
              <button class="asset-add-button" id="uploadImages" type="button" disabled>＋ 添加正文图片</button>
${assetToolsMarkup()}
              <input id="imageFiles" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
            </div>
            <section class="cover-manager">
              <div class="asset-section-heading"><div><strong>公众号封面</strong><small>建议使用 2.35:1 横图</small></div><label class="asset-check"><input id="metaShowCover" type="checkbox"><span>正文显示封面</span></label></div>
              <div class="cover-preview" id="coverPreview"><span>尚未选择封面</span></div>
              <button class="field-button" id="uploadCover" type="button">选择封面</button>
              <input id="coverFile" type="file" accept="image/png,image/jpeg" hidden>
            </section>
            <section class="body-assets">
              <div class="asset-section-heading"><div><strong>正文图片</strong><small id="assetSummary">暂无图片</small></div></div>
              <div class="asset-warnings" id="assetWarnings" hidden></div>
              <div class="asset-grid" id="assetGrid"></div>
            </section>
          </div>
        </div>

        <div class="preview-panel">
          <div class="preview-toolbar">
            <div class="preview-tabs" role="tablist">
              <button class="is-active" type="button" data-preview="wechat">公众号预览</button>
              <button type="button" data-preview="reader">本站预览</button>
            </div>
${scrollSyncMarkup()}
            <div class="preview-options">
              <label>版式<select id="themeSelect">${themeOptionsMarkup()}</select></label>
              <label><i class="palette-swatch" id="paletteSwatch"></i>配色<select id="paletteSelect"><option value="warm">默认配色</option><option value="wechat">公众号绿</option><option value="blue">AMD 官网蓝</option><option value="red">典雅红</option><option value="violet">紫罗兰</option><option value="ink">墨金</option></select></label>
            </div>
          </div>
${typographyControlsMarkup()}
${authoringToolsMarkup()}
          <div class="phone-stage">
            <article class="wechat-preview" id="previewArticle"><div id="output"></div></article>
          </div>
        </div>

        <aside class="publish-panel">
          <div class="panel-heading"><span>发布检查</span></div>
          <section class="account-status" id="accountStatus">
            <div class="account-status-heading"><span class="status-dot" id="accountDot"></span><div><strong>目标公众号</strong><small id="accountSummary">尚未绑定</small></div></div>
            <select id="accountSelect" aria-label="选择目标公众号"><option value="">请选择公众号</option></select>
            <button class="manage-account-button" id="manageAccounts" type="button">管理公众号</button>
          </section>
          <div class="check-list" id="preflightList"></div>
          <div class="sync-blocker" id="syncBlocker" hidden></div>
          <div class="publish-state" id="publishState"></div>
          <div class="publish-help">
            <strong>推荐流程</strong>
            <p>先同步到公众号草稿箱，在公众号后台或手机端复核；确认无误后再发布。</p>
          </div>
        </aside>
      </section>
    </main>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>
    <dialog class="account-dialog" id="accountDialog">
      <div class="dialog-heading"><div><strong>绑定微信公众号</strong><small>绑定后，文章可以直接同步到所选公众号的草稿箱。</small></div><button id="closeAccountDialog" type="button" aria-label="关闭">×</button></div>
      <div class="account-dialog-body">
        <section><div class="dialog-section-title"><strong>已绑定账号</strong><span id="boundAccountCount">0</span></div><div class="bound-account-list" id="boundAccountList"></div></section>
        <form class="account-form" id="accountForm">
          <div class="dialog-section-title"><strong>绑定新公众号</strong></div>
          <ol class="binding-steps"><li>进入公众号后台的“设置与开发 → 基本配置”</li><li>把本机公网出口 IP 加入接口白名单</li><li>复制 AppID 和 AppSecret，在下方完成验证</li></ol>
          <label><span>账号名称</span><input id="accountName" maxlength="32" required placeholder="例如：星河炸鸡"></label>
          <label><span>AppID</span><input id="accountAppId" maxlength="64" required autocomplete="off" placeholder="wx…"></label>
          <label><span>AppSecret</span><input id="accountAppSecret" type="password" maxlength="128" required autocomplete="new-password" placeholder="仅保存到本机后端"></label>
          <div class="account-form-error" id="accountFormError" hidden></div>
          <button class="primary-action" id="bindAccount" type="submit">验证并绑定</button>
        </form>
      </div>
    </dialog>
    <dialog class="archive-dialog" id="archiveDialog">
      <div class="dialog-heading">
        <div><strong>一键归档公众号</strong><small>扫码登录后，自动把历史文章和素材保存为本地 Markdown。</small></div>
        <button id="closeArchiveDialog" type="button" aria-label="关闭">×</button>
      </div>
      <div class="archive-dialog-body">
        <section class="archive-intro">
          <span class="archive-local-badge">仅在本机运行</span>
          <h2>扫一次码，后面自动完成</h2>
          <ol>
            <li><span>1</span><div><strong>登录目标公众号</strong><small>Chrome 或 Edge 弹出后，用管理员微信扫码。</small></div></li>
            <li><span>2</span><div><strong>读取历史文章</strong><small>自动翻页获取当前账号可见的文章。</small></div></li>
            <li><span>3</span><div><strong>保存 Markdown 与素材</strong><small>正文、封面和图片按文章整理到本机。</small></div></li>
          </ol>
          <p>只处理你有权管理的公众号。Cookie 和文章不会上传到第三方服务器。</p>
        </section>
        <section class="archive-control">
          <form id="archiveForm" class="archive-setup">
            <div class="archive-section-title"><strong>开始新的归档</strong><small>切换公众号时保持“每次重新扫码”开启</small></div>
            <label class="archive-name"><span>公众号名称</span><input id="archiveAccountName" maxlength="60" required autocomplete="off" placeholder="例如：我的第二个公众号"></label>
            <div class="archive-path"><span>保存位置</span><code id="archiveOutputPath">正在读取…</code></div>
            <fieldset>
              <legend>归档内容</legend>
              <label><input type="checkbox" checked disabled><span><strong>正文与图片</strong><small>始终保存</small></span></label>
              <label><input id="archiveAudio" type="checkbox" checked><span><strong>音频</strong><small>如文章包含</small></span></label>
              <label><input id="archiveVideo" type="checkbox" checked><span><strong>视频</strong><small>如可直接获取</small></span></label>
              <label><input id="archiveComments" type="checkbox"><span><strong>留言</strong><small>速度较慢</small></span></label>
              <label><input id="archiveStats" type="checkbox"><span><strong>阅读数据</strong><small>容易受接口限制</small></span></label>
            </fieldset>
            <div class="archive-session-options">
              <label><input id="archiveFreshLogin" type="checkbox" checked><span>每次重新扫码 <small>切换公众号时必须开启</small></span></label>
              <label><input id="archiveClearSession" type="checkbox" checked><span>完成后清除登录信息 <small>适合代朋友操作</small></span></label>
            </div>
            <div class="archive-error" id="archiveError" hidden></div>
            <button class="archive-start-button" id="startArchive" type="submit">打开浏览器并开始归档</button>
          </form>
          <div class="archive-progress-panel" id="archiveProgressPanel" hidden>
            <div class="archive-status-heading">
              <span class="archive-phase" id="archivePhase">准备就绪</span>
              <strong id="archiveMessage">等待开始</strong>
              <small id="archiveCurrentTitle"></small>
            </div>
            <div class="archive-progress-track"><i id="archiveProgressBar"></i></div>
            <div class="archive-progress-meta"><span id="archiveProgressCount">准备中</span><strong id="archiveProgressPercent">0%</strong></div>
            <div class="archive-counts">
              <div><strong id="archiveCompleted">0</strong><span>成功</span></div>
              <div><strong id="archiveFailed">0</strong><span>失败</span></div>
              <div><strong id="archiveSkipped">0</strong><span>跳过</span></div>
            </div>
            <div class="archive-result-path"><span>保存位置</span><code id="archiveResultPath">—</code></div>
            <div class="archive-progress-actions">
              <button id="cancelArchive" class="archive-danger-button" type="button">停止归档</button>
              <button id="openArchiveFolder" type="button">打开文件夹</button>
              <button id="restartArchive" class="archive-start-button" type="button">归档另一个公众号</button>
              <button id="clearArchiveSession" type="button">清除本机登录信息</button>
            </div>
          </div>
        </section>
      </div>
    </dialog>
    <dialog class="delete-draft-dialog" id="deleteDraftDialog">
      <div class="delete-draft-heading"><strong>删除本地稿件</strong><button id="closeDeleteDraft" type="button" aria-label="关闭">×</button></div>
      <div class="delete-draft-body">
        <p>确定删除《<strong id="deleteDraftTitle">未命名文章</strong>》吗？</p>
        <div><strong>移入本机回收站</strong><span>正文、封面和原图将一起保留，可在“创作工具 → 回收站”恢复。已同步的微信草稿继续保留。</span></div>
        <div class="delete-draft-actions"><button id="cancelDeleteDraft" type="button">取消</button><button id="confirmDeleteDraft" type="button">确认删除</button></div>
      </div>
    </dialog>
  </div>`;
const query = (t) => document.querySelector(t),
  ui = {
    list: query("#draftList"),
    count: query("#draftCount"),
    empty: query("#emptyEditor"),
    grid: query("#composeGrid"),
    title: query("#currentTitle"),
    saveState: query("#saveState"),
    save: query("#saveDraft"),
    images: query("#uploadImages"),
    sync: query("#syncDraft"),
    publish: query("#publishDraft"),
    preview: query("#previewArticle"),
    wordCount: query("#wordCount"),
    assetCount: query("#assetCount"),
    assetSummary: query("#assetSummary"),
    assetWarnings: query("#assetWarnings"),
    assetGrid: query("#assetGrid"),
    coverPreview: query("#coverPreview"),
    account: query("#accountStatus"),
    accountSelect: query("#accountSelect"),
    accountSummary: query("#accountSummary"),
    accountDot: query("#accountDot"),
    syncBlocker: query("#syncBlocker"),
    wechatEntry: query("#wechatConfigEntry"),
    wechatEntryTitle: query("#wechatEntryTitle"),
    wechatEntryMeta: query("#wechatEntryMeta"),
    archiveEntry: query("#archiveEntry"),
    archiveEntryTitle: query("#archiveEntryTitle"),
    archiveEntryMeta: query("#archiveEntryMeta"),
    checks: query("#preflightList"),
    publishState: query("#publishState"),
    serviceWarning: query("#serviceWarning"),
    toast: query("#toast"),
    titleInput: query("#metaTitle"),
    authorInput: query("#metaAuthor"),
    digestInput: query("#metaDigest"),
    sourceInput: query("#metaSource"),
    commentInput: query("#metaComment"),
    fansInput: query("#metaFansComment"),
    showCoverInput: query("#metaShowCover"),
  };
async function request(t, e = {}) {
  const n = new Headers(e.headers);
  (e.body && n.set("Content-Type", "application/json"),
    state.config && n.set("X-Editor-Token", state.config.csrf_token));
  const r = await fetch(t, { ...e, headers: n }),
    i = await r.json().catch(() => ({}));
  if (!r.ok) {
    const error = new Error(i.error || `请求失败 (${r.status})`);
    error.status = r.status;
    error.payload = i;
    throw error;
  }
  return i;
}
let workflow;
let authoring;
const codeFolding = createCodeFolding({
  StateField,
  StateEffect,
  WidgetType,
  Decoration,
  EditorView,
});
const richRuntime = loadRichRuntime().catch((error) => {
  toast(
    "本地图表组件加载失败，普通文章仍可编辑；含公式或图表的同步会停止",
    true,
  );
  return null;
});
const recovery = createRecoveryController({
  storage: createIndexedDBRecoveryStore(window.indexedDB),
  capture: () =>
    state.current
      ? {
          id: state.current.id,
          revision: state.current.revision,
          content: getContent(),
          metadata: readMetadata(),
        }
      : null,
  onState: (value) => {
    if (value.id === state.current?.id)
      query("#recoveryState").textContent =
        {
          pending: " · 暂存待写入",
          saving: " · 本机暂存中",
          stored: value.cleared ? "" : " · 已本机暂存",
          error: " · 暂存失败，请手工保存",
        }[value.status] || "";
    if (value.error)
      toast("本机恢复记录写入失败，请立即手工保存或导出文章包", true);
    workflow?.refresh();
  },
});
const saveDraft = createDraftSaver({
  state,
  request,
  getContent,
  readMetadata,
  setDirty,
  refreshList: loadDrafts,
  onAccepted: (draft) => {
    ui.title.textContent = draft.metadata.title || "未命名文章";
    renderPublishState();
  },
  onSaved: async (record) => {
    try {
      await recovery.flush();
      await recovery.clearSaved(record);
    } catch {
      /* A local recovery failure must not undo a confirmed backend save. */
    }
  },
  onError: (error, local) => {
    toast(error.message, true);
    workflow?.conflictSave(error, local);
  },
});
workflow = connectWorkflowUI(document, {
  request,
  getDraft: () => state.current,
  getContent,
  getMetadata: readMetadata,
  getAssets: () => state.assets,
  getHtml: preparePublishHTML,
  getRenderVersion: () => state.config?.render_version,
  ignoredWords: () => proofreading.ignoredWords,
  recovery,
  toast,
  restoreLocal,
  selectIssue: selectWorkflowIssue,
  beforeImport: async () => {
    if (state.dirty && !(await saveDraft()))
      throw new Error("当前修改尚未成功保存，请保存或另存副本后继续");
  },
  onImported: async (draft) => {
    await loadDrafts();
    if (state.dirty && !(await saveDraft()))
      throw new Error("新稿已保存；当前仍有新输入，请先保存后从列表打开新稿");
    await openDraft(draft.id);
  },
  onConflictCopy: async (draft, local) => {
    await loadDrafts();
    if (
      state.current?.id !== local.id ||
      getContent() !== local.content ||
      JSON.stringify(readMetadata()) !== JSON.stringify(local.metadata)
    )
      throw new Error("副本已保存；编辑区有更新输入，请先处理后从列表打开副本");
    setDirty(false);
    await recovery.clearSaved(local).catch(() => {});
    await openDraft(draft.id);
  },
  onRestored: loadDrafts,
  downloadPackage,
  applyMetadata: (values) => {
    state.current.metadata = {
      ...state.current.metadata,
      ...readMetadata(),
      ...values,
    };
    loadMetadata(state.current.metadata);
    setDirty(true);
    renderPreview();
  },
  insertMarkdown,
  createTemplate: async (value) => {
    const result = await request("/api/editor/drafts", {
      method: "POST",
      body: JSON.stringify({
        content: value.content,
        metadata: value.metadata,
        title: value.metadata.title,
      }),
    });
    await loadDrafts();
    await openDraft(result.id);
  },
});
authoring = connectAuthoringTools(document, {
  getContent,
  getMetadata: readMetadata,
  getEditor: () => state.editor,
  getPreview: () => ui.preview,
  lexMarkdown: lexArticleMarkdown,
  onChange: (values) => {
    if (!state.current) return;
    state.current.metadata = { ...state.current.metadata, ...values };
    setDirty(true);
    renderPreview();
  },
  selectRange: (from, to) => {
    showSourcePane("content");
    state.editor?.dispatch({
      selection: { anchor: from, head: to },
      scrollIntoView: true,
    });
    state.editor?.focus();
  },
  onToggleCodeFold: (folded) => codeFolding.set(state.editor, folded),
  onApplyPreset: (settings) => {
    if (!state.current) return;
    const values = { ...readMetadata(), ...settings };
    state.current.metadata = values;
    loadMetadata(values);
    setDirty(true);
    renderPreview();
  },
});
const proofreading = connectProofreading(document, {
  getText: getContent,
  getDraftId: () => state.current?.id || "",
  getDirty: () => state.dirty,
  replaceText: (next, expected, id) => {
    if (state.current?.id !== id || getContent() !== expected)
      throw new Error("正文已变化，请重新检查");
    const view = state.editor;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      selection: {
        anchor: Math.min(view.state.selection.main.head, next.length),
      },
    });
  },
  select: (issue) => {
    showSourcePane("content");
    state.editor?.dispatch({
      selection: { anchor: issue.from, head: issue.to },
      scrollIntoView: true,
    });
    state.editor?.focus();
  },
  beforeReplace: () => captureVisibleVersion("before-proofreading"),
  save: () => saveDraft("proofreading"),
  onMarksChanged: () => state.editor?.dispatch({}),
});
const typographyControls = connectTypographyControls(document, () => {
  setDirty(!0);
  renderPreview();
});
const syncProgress = connectSyncProgress(document, {
  request,
  getDraftId: () => state.current?.id || "",
  getAccountId: () => readMetadata().wechat_account_id || "",
  onSyncWithChoice: (choice) => syncDraft(choice),
  toast,
  onCompleted: async (job) => {
    const currentId = state.current?.id;
    await loadDrafts();
    if (currentId === job.draft_id) {
      const latest = await request(
        `/api/editor/drafts/${encodeURIComponent(currentId)}`,
      );
      if (state.current?.id === currentId) {
        state.current.publish = latest.publish;
        renderPublishState();
        renderPreflight();
        const exact =
          state.current.revision === job.result?.draft_revision &&
          !state.dirty &&
          readMetadata().wechat_account_id === job.account_id;
        toast(
          exact
            ? "本次版本已同步并完成远端核对"
            : "本次快照已同步；当前编辑区另有修改或目标账号已变化",
        );
      }
    }
  },
});
const assetTools = connectAssetTools(document, {
  request,
  getDraft: () => state.current,
  getContent,
  getMetadata: readMetadata,
  beforeChange: captureVisibleVersion,
  replaceContent: (next, expected, id) => {
    if (state.current?.id !== id || getContent() !== expected)
      throw new Error("正文已变化，请重新预览后应用");
    state.editor.dispatch({
      changes: { from: 0, to: state.editor.state.doc.length, insert: next },
      selection: {
        anchor: Math.min(state.editor.state.selection.main.head, next.length),
      },
    });
    return true;
  },
  applyMetadata: (values, id) => {
    if (state.current?.id !== id) throw new Error("稿件已切换");
    state.current.metadata = {
      ...state.current.metadata,
      ...readMetadata(),
      ...values,
    };
    loadMetadata(state.current.metadata);
    setDirty(true);
    renderPreview();
  },
  onChanged: async () => {
    await loadAssets();
    renderPreview();
  },
  assetUrl: (path, id) => assetUrl(id, path),
  toast,
});
const scrollLexer = new MarkdownLexer();
const scrollSync = connectScrollSync(document, {
  lexMarkdown: (text) => {
    const { markdownContent: content } =
      markdownRenderer.parseFrontMatterAndContent(text);
    return { content, tokens: scrollLexer.lexer(content) };
  },
});
function readMetadata() {
  return {
    ...state.current?.metadata,
    ...authoring?.read(),
    ...typographyControls.read(state.theme),
    title: ui.titleInput.value.trim(),
    author: ui.authorInput.value.trim(),
    digest: ui.digestInput.value.trim(),
    cover: state.current?.metadata.cover || "",
    source_url: ui.sourceInput.value.trim(),
    need_open_comment: ui.commentInput.checked,
    only_fans_can_comment: ui.fansInput.checked,
    show_cover_pic: ui.showCoverInput.checked,
    theme: state.theme,
    palette: state.palette,
    wechat_account_id: ui.accountSelect.value,
  };
}
function loadMetadata(t) {
  typographyControls.load(t);
  authoring?.load(t);
  ((ui.titleInput.value = t.title || ""),
    (ui.authorInput.value = t.author || ""),
    (ui.digestInput.value = t.digest || ""),
    (ui.sourceInput.value = t.source_url || ""),
    (ui.commentInput.checked = !!t.need_open_comment),
    (ui.fansInput.checked = !!t.only_fans_can_comment),
    (ui.showCoverInput.checked = !!t.show_cover_pic),
    (state.theme = t.theme || "grace"),
    (state.palette = t.palette || "warm"),
    (query("#themeSelect").value = state.theme),
    (query("#paletteSelect").value = state.palette),
    (query("#paletteSwatch").style.background =
      palettes[state.palette].primary),
    (ui.accountSelect.value = t.wechat_account_id || ""),
    renderAccountState());
  const e = query("#uploadCover");
  e.textContent = t.cover
    ? `更换封面 · ${t.cover.split("/").pop()}`
    : "选择封面";
}
function setDirty(t) {
  if (t && state.current && state.editor) recovery.changed();
  ((state.dirty = t),
    (ui.saveState.textContent = t
      ? "有未保存修改"
      : state.current
        ? `已保存 · ${formatTime(state.current.updated_at)}`
        : "尚未选择稿件"),
    ui.save.classList.toggle("has-change", t));
}
function formatTime(t) {
  return t
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(t))
    : "刚刚";
}
function toast(t, e = !1) {
  ((ui.toast.textContent = t),
    ui.toast.classList.toggle("is-error", e),
    ui.toast.classList.add("is-visible"),
    window.setTimeout(() => ui.toast.classList.remove("is-visible"), 2800));
}
function renderDraftList() {
  ((ui.count.textContent = String(state.drafts.length)),
    (ui.list.innerHTML = state.drafts.length
      ? state.drafts
          .map(
            (t) => `
    <div class="draft-row ${t.id === state.current?.id ? "is-active" : ""}">
      <button class="draft-open" data-draft-id="${escapeHtml(t.id)}" type="button">
        <strong>${escapeHtml(t.title || "未命名文章")}</strong>
        <span>${escapeHtml(formatTime(t.updated_at))}${t.publish_status ? ` · ${escapeHtml(publishStatusLabel(t.publish_status))}` : ""}</span>
      </button>
      <button class="draft-delete" data-delete-draft="${escapeHtml(t.id)}" type="button" aria-label="删除稿件 ${escapeHtml(t.title || "未命名文章")}" title="删除本地稿件">×</button>
    </div>`,
          )
          .join("")
      : '<div class="empty-list">还没有本地稿件</div>'));
}
function escapeHtml(t) {
  const e = document.createElement("span");
  return ((e.textContent = t), e.innerHTML);
}
function formatBytes(t) {
  return t < 1024
    ? `${t} B`
    : t < 1024 * 1024
      ? `${(t / 1024).toFixed(1)} KB`
      : `${(t / (1024 * 1024)).toFixed(1)} MB`;
}
function showSourcePane(t) {
  ((state.sourceMode = t),
    document.querySelectorAll("[data-source-mode]").forEach((e) => {
      const n = e.dataset.sourceMode === t;
      (e.classList.toggle("is-active", n),
        e.setAttribute("aria-selected", String(n)));
    }),
    document.querySelectorAll("[data-source-pane]").forEach((e) => {
      e.hidden = e.dataset.sourcePane !== t;
    }),
    t === "content" && (state.editor?.requestMeasure(), state.editor?.focus()),
    t === "assets" && renderAssets());
}
function insertMarkdown(t) {
  const e = state.editor;
  if (!e) return;
  const n = e.state.selection.main.head,
    r = `

${t}

`;
  (e.dispatch({
    changes: { from: n, insert: r },
    selection: { anchor: n + r.length },
  }),
    showSourcePane("content"));
}
function renderAssets() {
  if (!state.current) return;
  const t = imageReferences(getContent()),
    e = new Set(t),
    n = state.assets.filter((u) => u.path.startsWith("images/")),
    r = new Set(state.assets.map((u) => u.path)),
    i = t.filter((u) => !isRemoteImage(u) && !r.has(u)),
    s = t.filter(isRemoteImage);
  ((ui.assetCount.textContent = String(n.length)),
    (ui.assetSummary.textContent = n.length
      ? `${n.length} 张 · ${e.size} 处引用`
      : "暂无图片"));
  const a = [];
  (i.length && a.push(`有 ${i.length} 个本地引用尚未上传`),
    s.length && a.push(`有 ${s.length} 张远程图片，发布前需转为本地素材`),
    (ui.assetWarnings.hidden = a.length === 0),
    (ui.assetWarnings.innerHTML = a
      .map((u) => `<p>${escapeHtml(u)}</p>`)
      .join("")));
  const o = state.current.metadata.cover;
  ((ui.coverPreview.innerHTML = o
    ? `<a href="${escapeHtml(assetUrl(state.current.id, o))}" target="_blank" rel="noreferrer"><img src="${escapeHtml(assetUrl(state.current.id, o))}" alt="公众号封面预览"></a>`
    : "<span>尚未选择封面</span>"),
    (ui.assetGrid.innerHTML = n.length
      ? n
          .map((u) => {
            const l = e.has(u.path),
              c = assetUrl(state.current.id, u.path);
            return `<article class="asset-card">
      <a class="asset-thumb" href="${escapeHtml(c)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(c)}" alt="${escapeHtml(assetBasename(u.path))}"></a>
      <div><strong title="${escapeHtml(u.path)}">${escapeHtml(assetBasename(u.path))}</strong><span>${escapeHtml(formatBytes(u.size))} · ${l ? "正文已引用" : "尚未引用"}</span></div>
      <button type="button" data-insert-asset="${escapeHtml(u.path)}">${l ? "再次插入" : "插入正文"}</button>
    </article>`;
          })
          .join("")
      : '<div class="asset-empty"><span>▧</span><strong>还没有正文图片</strong><p>添加图片后会自动插入 Markdown，并在这里集中预览。</p></div>'));
}
async function loadAssets() {
  if (!state.current) return;
  const t = state.current.id;
  try {
    const e = await request(
      `/api/editor/drafts/${encodeURIComponent(t)}/assets`,
    );
    if (state.current?.id !== t) return;
    ((state.assets = e.items), renderAssets(), renderPreflight());
  } catch (e) {
    ((state.assets = []),
      renderAssets(),
      renderPreflight(),
      toast(e.message, !0));
  }
}
function publishStatusLabel(t) {
  return (
    {
      draft_synced: "已同步",
      submitted: "发布中",
      publish_success: "已发布",
      originality_fail: "原创校验失败",
      publish_fail: "发布失败",
      platform_audit_fail: "平台审核失败",
      deleted_after_publish: "发布后已删除",
      banned_after_publish: "发布后被封禁",
    }[t] || t
  );
}
function createEditor(t) {
  scrollSync.detachEditor();
  (state.editor?.destroy(),
    (state.editor = new EditorView({
      parent: query("#sourceEditor"),
      state: EditorState.create({
        doc: t,
        extensions: [
          codeFolding.extension,
          createProofreadingExtension(
            { ViewPlugin: ViewPlugin, Decoration: Decoration },
            proofreading,
          ),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, tabKeyBinding]),
          markdownExtensions(),
          placeholder("在这里书写 Markdown…"),
          EditorView.lineWrapping,
          EditorView.updateListener.of((e) => {
            e.docChanged &&
              (scrollSync.invalidate(), setDirty(!0), schedulePreview());
          }),
        ],
      }),
    })));
  scrollSync.attachEditor(state.editor);
}
function getContent() {
  return state.editor?.state.doc.toString() || "";
}
async function restoreLocal(record) {
  if (!record) return;
  if (state.dirty) await recovery.flush().catch(() => {});
  let saved;
  try {
    saved = await request(
      `/api/editor/drafts/${encodeURIComponent(record.id)}`,
    );
  } catch {}
  state.current = {
    ...saved,
    id: record.id,
    content: record.content,
    metadata: record.metadata,
    revision: record.revision,
    publish: saved?.publish || {},
    updated_at: saved?.updated_at || "",
  };
  state.assets = [];
  ui.empty.hidden = true;
  ui.grid.hidden = false;
  ui.title.textContent = record.metadata.title || "恢复稿件";
  ui.save.disabled = false;
  ui.images.disabled = false;
  loadMetadata(record.metadata);
  createEditor(record.content);
  showSourcePane("content");
  setDirty(true);
  renderPreview();
  loadAssets();
  toast(
    saved && saved.revision !== record.revision
      ? "已恢复输入；后端有另一版本，保存时可比较并另存副本"
      : "已恢复本机暂存，请检查后保存",
  );
}
function selectWorkflowIssue(issue) {
  if (issue.field === "content" && Number.isInteger(issue.from)) {
    showSourcePane("content");
    state.editor?.dispatch({
      selection: { anchor: issue.from, head: issue.to ?? issue.from },
      scrollIntoView: true,
    });
    state.editor?.focus();
  } else if (
    ["title", "digest", "source_url", "cover", "account"].includes(issue.field)
  ) {
    showSourcePane("settings");
    ({
      title: ui.titleInput,
      digest: ui.digestInput,
      source_url: ui.sourceInput,
      account: ui.accountSelect,
    })[issue.field]?.focus();
  } else if (issue.field === "assets") showSourcePane("assets");
  query("#workflowDialog").close();
}
async function downloadPackage(id) {
  if (state.current?.id === id && state.dirty && !(await saveDraft()))
    throw new Error("请先保存当前修改后导出");
  const response = await fetch(
    `/api/editor/drafts/${encodeURIComponent(id)}/export`,
    { headers: { "X-Editor-Token": state.config?.csrf_token || "" } },
  );
  if (!response.ok) throw new Error("文章包导出失败");
  const url = URL.createObjectURL(await response.blob()),
    link = document.createElement("a");
  link.href = url;
  link.download =
    (state.current?.metadata.title || "article").replace(/[<>:"/\\|?*]/g, "_") +
    ".zip";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function schedulePreview() {
  (window.clearTimeout(state.previewTimer),
    (state.previewTimer = window.setTimeout(renderPreview, 180)));
}
async function renderPreview() {
  if (!state.current) return;
  const generation = (state.previewGeneration || 0) + 1;
  state.previewGeneration = generation;
  const draftId = state.current.id;
  const runtime = await richRuntime;
  if (
    !state.current ||
    state.current.id !== draftId ||
    generation !== state.previewGeneration
  )
    return;
  try {
    if (!runtime && /[\$]|```mermaid|~~~mermaid/i.test(getContent()))
      throw new Error("本地图表组件未就绪");
    query("#paletteSwatch").style.background =
      typographyAccent(state.theme, state.palette) ||
      palettes[state.palette].primary;
    const t = getContent(),
      initial = previewWechatArticle(t, state.theme, state.palette, {
        ...typographyControls.read(state.theme),
        block_overrides: readMetadata().block_overrides,
      });
    const rich = runtime
      ? await renderRichContent(renderMarkdownSource(t), {
          document,
          markdown: t,
          ...runtime,
          mode: "svg",
        })
      : { html: initial.html, ready: true };
    if (
      !state.current ||
      state.current.id !== draftId ||
      generation !== state.previewGeneration ||
      getContent() !== t
    )
      return;
    const e = previewWechatArticle(t, state.theme, state.palette, {
      ...typographyControls.read(state.theme),
      block_overrides: readMetadata().block_overrides,
      annotate: true,
      richHtml: rich.html,
    });
    ui.preview.dataset.richReady = rich.ready ? "true" : "false";
    let n = replaceAssetUrls(e.html, state.current.id);
    const r = "editorThemeStyle";
    let i = document.getElementById(r);
    (i ||
      ((i = document.createElement("style")),
      (i.id = r),
      document.head.appendChild(i)),
      (i.textContent = state.previewMode === "wechat" ? e.css : ""),
      (ui.preview.className =
        state.previewMode === "wechat"
          ? "wechat-preview"
          : "reader-preview md-content"),
      (ui.preview.innerHTML =
        state.previewMode === "wechat" ? `<div id="output">${n}</div>` : n));
    const s = t.replace(/\s/g, "").length;
    ((ui.wordCount.textContent = `${s.toLocaleString("zh-CN")} 字`),
      renderAssets(),
      renderPreflight(),
      scrollSync.refresh(state.current.id, t));
    authoring?.refresh(t);
  } catch (error) {
    if (
      state.current?.id === draftId &&
      state.previewGeneration === generation
    ) {
      ui.preview.textContent = "预览未完成：" + error.message;
      ui.preview.dataset.richReady = "false";
    }
  }
}
async function preparePublishHTML() {
  if (!state.current) throw new Error("请先选择稿件");
  const id = state.current.id,
    content = getContent(),
    metadata = readMetadata();
  const identity = JSON.stringify(metadata);
  const matches = () =>
    state.current?.id === id &&
    getContent() === content &&
    JSON.stringify(readMetadata()) === identity;
  const runtime = await richRuntime;
  if (!matches()) throw new Error("正文或设置已变化，请重新检查");
  if (!runtime && /[\$]|```mermaid|~~~mermaid/i.test(content))
    throw new Error("本地图表组件未就绪，无法同步包含公式或图表的文章");
  const raw = renderMarkdownSource(content);
  const rich = runtime
    ? await renderRichContent(raw, {
        document,
        markdown: content,
        ...runtime,
        mode: "png",
        scale: 2,
      })
    : { ready: true, html: raw, assets: [] };
  if (!rich.ready)
    throw new Error("有公式或图表未能安全渲染，请检查源码后重试");
  if (!matches()) throw new Error("正文或设置已变化，请重新检查");
  for (const asset of rich.assets) {
    if (state.assets.some((item) => item.path === asset.name)) continue;
    const file = new Blob([asset.bytes], { type: "image/png" });
    const n = new Uint8Array(await file.arrayBuffer());
    let text = "";
    for (let i = 0; i < n.length; i += 32768)
      text += String.fromCharCode(...n.subarray(i, i + 32768));
    await request(`/api/editor/drafts/${encodeURIComponent(id)}/assets`, {
      method: "POST",
      body: JSON.stringify({
        path: asset.name,
        data: btoa(text),
        derivation: {
          source: asset.source,
          derived_hash: asset.sha256,
          kind: "rich-content",
        },
      }),
    });
    if (!matches()) throw new Error("渲染期间稿件已变化，请重新检查");
  }
  if (rich.assets.length) await loadAssets();
  if (!matches()) throw new Error("正文或设置已变化，请重新检查");
  return exportWechatArticle(content, metadata.theme, metadata.palette, {
    ...metadata,
    richHtml: rich.html,
  });
}
async function captureVisibleVersion(reason = "manual-snapshot") {
  if (!state.current) throw new Error("请先选择稿件");
  const id = state.current.id,
    content = getContent(),
    metadata = readMetadata();
  await request(`/api/editor/drafts/${encodeURIComponent(id)}/snapshot`, {
    method: "POST",
    body: JSON.stringify({
      content,
      metadata,
      revision: state.current.revision,
      reason,
    }),
  });
  if (
    state.current?.id !== id ||
    getContent() !== content ||
    JSON.stringify(readMetadata()) !== JSON.stringify(metadata)
  )
    throw new Error("保存快照期间内容已变化，请重新预览后应用");
}
function renderPreflight() {
  if (!state.current) return;
  const t = readMetadata(),
    e = getContent(),
    n = imageReferences(e),
    r = [
      [
        !!(
          t.wechat_account_id &&
          state.accounts.some((a) => a.id === t.wechat_account_id)
        ),
        "已选择目标公众号",
      ],
      [!!t.title, "文章标题"],
      [e.trim().length > 0, "Markdown 正文"],
      [!!t.cover, "封面图片"],
      [t.digest.length <= 120, "摘要不超过 120 字"],
      [!n.some(isRemoteImage), "正文图片均为本地素材"],
      [
        missingImagePaths(n, state.assets, state.current.id).length === 0,
        "正文图片素材已全部上传",
      ],
    ];
  ui.checks.innerHTML = r
    .map(
      ([a, o]) =>
        `<div class="check-item ${a ? "is-ok" : "is-warn"}"><span>${a ? "✓" : "!"}</span>${o}</div>`,
    )
    .join("");
  const i = r.filter((a) => !a[0]).map((a) => a[1]),
    s = state.accounts.length === 0;
  ((ui.sync.disabled = s ? !1 : i.length > 0),
    (ui.sync.textContent = s ? "先绑定公众号" : "同步到草稿箱"),
    ui.sync.classList.toggle("needs-binding", s),
    (ui.sync.title = s
      ? "点击绑定微信公众号"
      : i.length
        ? `还需完成：${i.join("、")}`
        : ""),
    (ui.syncBlocker.hidden = i.length === 0),
    (ui.syncBlocker.textContent = i.length
      ? `暂不能同步：${i.join("、")}`
      : ""),
    renderPublishState());
}
function renderPublishState() {
  const t = state.current?.publish || {},
    e = [];
  (t.media_id &&
    e.push("<div><span>草稿箱</span><strong>已同步</strong></div>"),
    t.media_id &&
      t.render_version !== state.config?.render_version &&
      e.push('<p class="state-error">排版器已更新，请重新检查并同步此稿。</p>'),
    t.render_version &&
      e.push(
        `<div><span>同步排版版本</span><strong>${escapeHtml(t.render_version)}</strong></div>`,
      ),
    t.account_name &&
      e.push(
        `<div><span>同步账号</span><strong>${escapeHtml(t.account_name)}</strong></div>`,
      ),
    t.synced_at &&
      e.push(
        `<div><span>同步时间</span><strong>${escapeHtml(formatTime(t.synced_at))}</strong></div>`,
      ),
    t.publish_status &&
      e.push(
        `<div><span>发布状态</span><strong>${escapeHtml(publishStatusLabel(t.publish_status))}</strong></div>`,
      ),
    t.article_url &&
      e.push(
        `<a href="${escapeHtml(t.article_url)}" target="_blank" rel="noreferrer">打开已发布文章 ↗</a>`,
      ),
    t.publish_id &&
      t.publish_status === "submitted" &&
      e.push(
        '<button class="refresh-status" type="button" data-refresh-status>刷新发布状态</button>',
      ),
    t.last_error &&
      e.push(`<p class="state-error">${escapeHtml(t.last_error)}</p>`),
    (ui.publishState.innerHTML = e.length
      ? e.join("")
      : "<p>尚未同步到公众号</p>"),
    (ui.publish.disabled = !(
      state.config?.direct_publish_enabled &&
      t.media_id &&
      t.account_id === readMetadata().wechat_account_id &&
      t.draft_revision === state.current?.revision &&
      t.render_version === state.config?.render_version &&
      t.theme === state.theme &&
      t.palette === state.palette &&
      !state.dirty
    )),
    (ui.publish.title = state.config?.direct_publish_enabled
      ? ""
      : "直接发布默认关闭，可通过服务端配置开启"));
}
async function openDraft(t) {
  if (state.dirty) await recovery.flush().catch(() => {});
  if (state.dirty && !window.confirm("当前修改尚未保存，确定切换稿件吗？"))
    return;
  const e = await request(`/api/editor/drafts/${encodeURIComponent(t)}`);
  ((state.current = e),
    (state.assets = []),
    (ui.empty.hidden = !0),
    (ui.grid.hidden = !1),
    (ui.title.textContent = e.metadata.title || "未命名文章"),
    (ui.save.disabled = !1),
    (ui.images.disabled = !1),
    showSourcePane("content"),
    loadMetadata(e.metadata),
    createEditor(e.content),
    setDirty(!1),
    renderDraftList(),
    renderPreview(),
    loadAssets(),
    document.body.classList.remove("show-drafts"));
}
async function loadDrafts() {
  const t = await request("/api/editor/drafts");
  ((state.drafts = t.items), renderDraftList());
}
function closeDraft() {
  scrollSync.detachEditor();
  (state.editor?.destroy(),
    (state.editor = null),
    (state.current = null),
    (state.assets = []),
    (state.dirty = !1),
    proofreading.check(""),
    (ui.empty.hidden = !1),
    (ui.grid.hidden = !0),
    (ui.title.textContent = "创作区"),
    (ui.saveState.textContent = "尚未选择稿件"),
    (ui.save.disabled = !0),
    (ui.images.disabled = !0),
    (ui.sync.disabled = !0),
    (ui.publish.disabled = !0));
}
function showDeleteDraft(t) {
  const e = state.drafts.find((n) => n.id === t);
  e &&
    ((state.pendingDeleteDraftId = t),
    (query("#deleteDraftTitle").textContent = e.title || "未命名文章"),
    query("#deleteDraftDialog").showModal());
}
async function deleteDraft() {
  const t = state.pendingDeleteDraftId,
    e = state.drafts.find((i) => i.id === t);
  if (!e) return;
  const n = e.title || "未命名文章",
    r = query("#confirmDeleteDraft");
  ((r.disabled = !0), (r.textContent = "正在删除…"));
  try {
    (await request(`/api/editor/drafts/${encodeURIComponent(t)}`, {
      method: "DELETE",
    }),
      query("#deleteDraftDialog").close(),
      (state.pendingDeleteDraftId = ""),
      state.current?.id === t && closeDraft(),
      await loadDrafts(),
      toast(`已移入回收站：${n}`));
  } catch (i) {
    toast(i.message, !0);
  } finally {
    ((r.disabled = !1), (r.textContent = "确认删除"));
  }
}
async function createDraft(
  t = `# 未命名文章

从这里开始写作。`,
  e = "",
) {
  if (!state.config)
    throw new Error("编辑服务未连接，请重启本地服务后刷新页面");
  const n = inferTitle(t, e),
    r = await request("/api/editor/drafts", {
      method: "POST",
      body: JSON.stringify({ content: t, source_name: e, title: n }),
    });
  (await loadDrafts(), await openDraft(r.id), toast("已创建本地稿件"));
}
async function importMarkdown(t) {
  try {
    toast(`正在导入 ${t.name}…`);
    const e = await readMarkdownFile(t);
    (await createDraft(e, t.name), toast(`已导入 ${t.name}`));
  } catch (e) {
    toast(e.message, !0);
  }
} // Shared by Save, Ctrl+S, import, sync and the proofreading dialog.
// Queue requests so every PUT uses the revision from the previous response.
async function uploadAsset(t, e, draftId = state.current?.id) {
  if (!draftId) throw new Error("请先选择稿件");
  const n = new Uint8Array(await t.arrayBuffer());
  if (state.current?.id !== draftId)
    throw new Error("上传期间稿件已切换，请重新选择图片");
  let r = "";
  const i = 32768;
  for (let a = 0; a < n.length; a += i)
    r += String.fromCharCode(...n.subarray(a, a + i));
  const result = await request(
    `/api/editor/drafts/${encodeURIComponent(draftId)}/assets`,
    { method: "POST", body: JSON.stringify({ path: e, data: btoa(r) }) },
  );
  if (state.current?.id !== draftId)
    throw new Error("图片已加入原稿素材；当前稿件已切换，未应用图片");
  return result.path;
}
async function syncDraft(choice = {}) {
  if (!state.accounts.length) {
    showAccountConfig();
    return;
  }
  if (!state.current) return;
  if (!proofreading.beforeSync()) return;
  ui.sync.disabled = true;
  try {
    const checked = await workflow.prepareSync();
    if (!checked) return;
    const draft = state.current;
    if (!draft || state.dirty)
      throw new Error("正文或设置已经变化，请保存后重新检查");
    const content = getContent(),
      metadata = readMetadata();
    const source_hash = await sha256(content);
    if (state.current !== draft || getContent() !== content || state.dirty)
      throw new Error("稿件已变化，请重新检查");
    const result = await request(
      `/api/wechat/drafts/${encodeURIComponent(draft.id)}/sync`,
      {
        method: "POST",
        body: JSON.stringify({
          html: checked.html,
          source_hash,
          revision: draft.revision,
          theme: metadata.theme,
          palette: metadata.palette,
          typography: typographyControls.read(state.theme),
          render_version: state.config.render_version,
          account_id: metadata.wechat_account_id,
          preflight_fingerprint: checked.fingerprint,
          acknowledged: checked.acknowledged,
          remote_action: choice.remote_action || "",
          expected_remote_hash: choice.expected_remote_hash || "",
        }),
      },
    );
    await syncProgress.watch(result.job);
  } catch (error) {
    toast(error.message, true);
    if (error.payload?.job_id) {
      const r = await request(
        `/api/editor/sync-jobs/${encodeURIComponent(error.payload.job_id)}`,
      ).catch(() => null);
      if (r?.job) syncProgress.watch(r.job);
    }
  } finally {
    ui.sync.textContent = "同步到草稿箱";
    renderPreflight();
  }
}
async function publishDraft() {
  if (!(
    !state.current ||
    !window.confirm(
      `确定发布《${readMetadata().title}》吗？发布后将成为公开文章。`,
    )
  )) {
    ui.publish.disabled = !0;
    try {
      const t = await request(
        `/api/wechat/drafts/${encodeURIComponent(state.current.id)}/publish`,
        { method: "POST", body: "{}" },
      );
      ((state.current = t.draft),
        renderPublishState(),
        toast("已提交发布，正在等待公众号处理"));
    } catch (t) {
      toast(t.message, !0);
    }
  }
}
async function refreshPublishStatus() {
  if (!state.current) return;
  const t = ui.publishState.querySelector("[data-refresh-status]");
  t && ((t.disabled = !0), (t.textContent = "查询中…"));
  try {
    const e = await request(
      `/api/wechat/drafts/${encodeURIComponent(state.current.id)}/status?refresh=1`,
    );
    ((state.current = e.draft),
      await loadDrafts(),
      renderPublishState(),
      toast(
        e.draft.publish.publish_status === "submitted"
          ? "公众号仍在处理"
          : "发布状态已更新",
      ));
  } catch (e) {
    (toast(e.message, !0), renderPublishState());
  }
}
async function sha256(t) {
  const e = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(e))
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
function selectedAccount() {
  (setDirty(!0), schedulePreview());
}
function renderAccountState() {
  const t = state.accounts.find((n) => n.id === ui.accountSelect.value),
    e = state.accounts.length;
  (ui.accountDot.classList.toggle("is-online", !!t),
    (ui.accountSummary.textContent = t
      ? `${t.name} · ${t.app_id_hint}`
      : state.accounts.length
        ? "请选择本稿件的发布账号"
        : "尚未绑定公众号"),
    ui.wechatEntry.classList.toggle("needs-binding", e === 0),
    ui.wechatEntry.classList.toggle("is-configured", e > 0),
    (ui.wechatEntryTitle.textContent = e ? "公众号管理" : "绑定微信公众号"),
    (ui.wechatEntryMeta.textContent = e
      ? `已绑定 ${e} 个账号 · 点击配置`
      : "未配置 · 点击开始"));
}
function renderAccountSelect() {
  ((query("#boundAccountCount").textContent = String(state.accounts.length)),
    (query("#boundAccountList").innerHTML = state.accounts.length
      ? state.accounts
          .map(
            (t) => `
    <article class="bound-account-card">
      <span class="status-dot is-online"></span>
      <div><strong>${escapeHtml(t.name)}</strong><small>${escapeHtml(t.app_id_hint)}</small></div>
      <button type="button" data-delete-account="${escapeHtml(t.id)}">解除绑定</button>
    </article>`,
          )
          .join("")
      : '<div class="empty-bound-accounts">还没有绑定公众号</div>'));
}
async function loadAccounts(t = "") {
  const e =
      t ||
      ui.accountSelect?.value ||
      state.current?.metadata.wechat_account_id ||
      "",
    n = await request("/api/wechat/accounts");
  ((state.accounts = n.items),
    (ui.accountSelect.innerHTML = `<option value="">${state.accounts.length ? "请选择公众号" : "请先绑定公众号"}</option>${state.accounts.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join("")}`),
    state.accounts.some((r) => r.id === e) && (ui.accountSelect.value = e),
    state.config &&
      ((state.config.wechat_configured = state.accounts.length > 0),
      (state.config.wechat_account_count = state.accounts.length)),
    renderAccountState(),
    renderAccountSelect(),
    state.current && renderPreflight());
}
function showAccountConfig() {
  (renderAccountSelect(),
    (query("#accountFormError").hidden = !0),
    query("#accountDialog").showModal());
}
function resetAccountForm() {
  const t = n6(state.archive);
  ((ui.archiveEntryTitle.textContent = t.title),
    (ui.archiveEntryMeta.textContent = t.meta));
  const e = state.archive?.status || "idle";
  (ui.archiveEntry.classList.toggle("is-active", Fo.has(e)),
    ui.archiveEntry.classList.toggle("is-complete", e === "completed"),
    ui.archiveEntry.classList.toggle("is-error", e === "failed"));
}
function renderArchive() {
  const t = state.archive,
    e = query("#archiveForm"),
    n = query("#archiveProgressPanel"),
    r = !t || t.status === "idle" || state.archiveSetupVisible;
  if (
    ((e.hidden = !r),
    (n.hidden = r),
    (query("#archiveOutputPath").textContent =
      t?.output_dir || "本项目 output 文件夹"),
    !t)
  ) {
    resetAccountForm();
    return;
  }
  const i = query("#startArchive"),
    s = query("#archiveError");
  ((i.disabled = !t.available),
    (s.hidden = t.available),
    (s.textContent = t.available
      ? ""
      : `归档组件未就绪：${t.missing_dependencies.join("、")}`));
  const a = t6(t),
    o = r6(t.status),
    u = query("#archivePhase");
  ((u.textContent = t.phase || "归档任务"),
    (u.className = `archive-phase is-${o}`),
    (query("#archiveMessage").textContent = t.error || t.message || "正在处理"),
    (query("#archiveCurrentTitle").textContent = t.current_title
      ? `当前：${t.current_title}`
      : ""),
    (query("#archiveProgressBar").style.width = `${a}%`),
    (query("#archiveProgressPercent").textContent = `${Math.round(a)}%`),
    (query("#archiveProgressCount").textContent = t.total
      ? `第 ${t.current || 0} / ${t.total} 篇`
      : "正在准备文章列表"),
    (query("#archiveCompleted").textContent = String(t.completed || 0)),
    (query("#archiveFailed").textContent = String(t.failed || 0)),
    (query("#archiveSkipped").textContent = String(t.skipped || 0)),
    (query("#archiveResultPath").textContent =
      t.archive_dir || t.output_dir || "—"));
  const l = Fo.has(t.status),
    c = query("#cancelArchive");
  ((c.hidden = !l),
    (c.disabled = t.status === "canceling"),
    (c.textContent = t.status === "canceling" ? "正在停止…" : "停止归档"),
    (query("#openArchiveFolder").hidden = !(t.archive_dir && !l)),
    (query("#restartArchive").hidden = l));
  const h = query("#clearArchiveSession");
  ((h.hidden = l || !t.session_cached), (h.disabled = l), resetAccountForm());
}
function scheduleArchivePoll() {
  (window.clearTimeout(state.archiveTimer),
    !(!state.archive || !Fo.has(state.archive.status)) &&
      (state.archiveTimer = window.setTimeout(() => {
        loadArchive();
      }, 1e3)));
}
async function loadArchive() {
  try {
    ((state.archive = await request("/api/wechat/archive/status")),
      renderArchive(),
      scheduleArchivePoll());
  } catch (t) {
    (resetAccountForm(), query("#archiveDialog").open && toast(t.message, !0));
  }
}
async function showArchive() {
  state.archiveSetupVisible = !1;
  const t = query("#archiveDialog");
  (t.open || t.showModal(), await loadArchive());
}
async function initialize() {
  try {
    ((state.config = await request("/api/editor/config")),
      (ui.serviceWarning.hidden = !0),
      await loadAccounts(),
      await loadArchive(),
      await loadDrafts());
  } catch (t) {
    const e = t.message;
    ((ui.serviceWarning.hidden = !1),
      (ui.serviceWarning.querySelector("strong").textContent =
        "编辑服务版本不匹配或未连接"),
      (ui.serviceWarning.querySelector("span").innerHTML =
        `接口返回：${escapeHtml(e)}。请关闭旧发布器服务，重新运行本机发布器启动程序，然后刷新本页。`),
      toast(e, !0));
  }
}
query("#newDraft").addEventListener("click", () =>
  createDraft().catch((t) => toast(t.message, !0)),
);
connectRocmImport(document, {
  request: request,
  beforeImport: async () => {
    if (state.dirty && !(await saveDraft()))
      throw new Error("当前修改保存失败，请先保存后再导入");
  },
  onImported: async (draft) => {
    await loadDrafts();
    if (state.dirty && !(await saveDraft()))
      throw new Error(
        "新稿已导入，当前修改保存失败；请保存后从稿件列表打开新稿",
      );
    await openDraft(draft.id);
    toast("已导入 ROCm 博客，正文与配图已保存到本地");
  },
});
query("#importMarkdown").addEventListener("click", () =>
  workflow.open("import"),
);
query("[data-open-import]").addEventListener("click", () =>
  workflow.open("import"),
);
query("#markdownFile").addEventListener("change", async (t) => {
  const e = t.currentTarget,
    n = e.files?.[0];
  (n && (await importMarkdown(n)), (e.value = ""));
});
ui.list.addEventListener("click", (t) => {
  const e = t.target.closest("[data-delete-draft]");
  if (e?.dataset.deleteDraft) {
    showDeleteDraft(e.dataset.deleteDraft);
    return;
  }
  const n = t.target.closest("[data-draft-id]");
  n?.dataset.draftId && openDraft(n.dataset.draftId);
});
ui.save.addEventListener("click", () =>
  saveDraft().then((t) => t && toast("稿件已保存")),
);
ui.images.addEventListener("click", () => query("#imageFiles").click());
query("#imageFiles").addEventListener("change", async (t) => {
  const e = t.currentTarget,
    n = Array.from(e.files || []);
  if (!(!state.current || !n.length))
    try {
      const r = [],
        draftId = state.current.id;
      for (const i of n) {
        if (state.current?.id !== draftId)
          throw new Error("稿件已切换，停止后续图片上传");
        const target = imageUploadTarget(i.name, imageReferences(getContent()));
        const s = await uploadAsset(i, target.path, draftId);
        if (
          target.insert ||
          canonicalAssetPath(s) !== canonicalAssetPath(target.path)
        )
          r.push(`![${i.name.replace(/\.[^.]+$/, "")}](${s})`);
      }
      (await loadAssets(),
        renderPreview(),
        r.length &&
          insertMarkdown(
            r.join(`

`),
          ),
        toast(`已添加 ${n.length} 张图片`));
    } catch (r) {
      toast(r.message, !0);
    } finally {
      e.value = "";
    }
});
query("#uploadCover").addEventListener("click", () =>
  query("#coverFile").click(),
);
query("#coverFile").addEventListener("change", async (t) => {
  const e = t.currentTarget,
    n = e.files?.[0];
  if (!(!state.current || !n)) {
    try {
      const r = n.name.toLowerCase().endsWith(".png") ? ".png" : ".jpg";
      ((state.current.metadata.cover = await uploadAsset(n, `cover${r}`)),
        (state.current.metadata = {
          ...state.current.metadata,
          ...readMetadata(),
        }),
        loadMetadata(state.current.metadata),
        await loadAssets(),
        setDirty(!0),
        renderPreflight(),
        toast("封面已加入稿件"));
    } catch (r) {
      toast(r.message, !0);
    }
    e.value = "";
  }
});
ui.sync.addEventListener("click", syncDraft);
ui.publish.addEventListener("click", publishDraft);
ui.publishState.addEventListener("click", (t) => {
  t.target.closest("[data-refresh-status]") && refreshPublishStatus();
});
ui.accountSelect.addEventListener("change", () => {
  (renderAccountState(), selectedAccount());
});
query("#manageAccounts").addEventListener("click", showAccountConfig);
ui.wechatEntry.addEventListener("click", showAccountConfig);
ui.archiveEntry.addEventListener("click", () => {
  showArchive();
});
query("#closeAccountDialog").addEventListener("click", () =>
  query("#accountDialog").close(),
);
query("#accountDialog").addEventListener("click", (t) => {
  t.target === t.currentTarget && t.currentTarget.close();
});
query("#closeArchiveDialog").addEventListener("click", () =>
  query("#archiveDialog").close(),
);
query("#archiveDialog").addEventListener("click", (t) => {
  t.target === t.currentTarget && t.currentTarget.close();
});
function connectEvents() {
  (query("#deleteDraftDialog").close(), (state.pendingDeleteDraftId = ""));
}
query("#closeDeleteDraft").addEventListener("click", connectEvents);
query("#cancelDeleteDraft").addEventListener("click", connectEvents);
query("#confirmDeleteDraft").addEventListener("click", () => {
  deleteDraft();
});
query("#deleteDraftDialog").addEventListener("click", (t) => {
  t.target === t.currentTarget && connectEvents();
});
query("#archiveForm").addEventListener("submit", async (t) => {
  t.preventDefault();
  const e = query("#startArchive"),
    n = query("#archiveError");
  ((e.disabled = !0), (e.textContent = "正在启动本机浏览器…"), (n.hidden = !0));
  try {
    ((state.archive = await request("/api/wechat/archive/start", {
      method: "POST",
      body: JSON.stringify({
        account_name: query("#archiveAccountName").value,
        fresh_login: query("#archiveFreshLogin").checked,
        clear_session_after: query("#archiveClearSession").checked,
        download_images: !0,
        download_audio: query("#archiveAudio").checked,
        download_video: query("#archiveVideo").checked,
        download_comments: query("#archiveComments").checked,
        download_stats: query("#archiveStats").checked,
      }),
    })),
      (state.archiveSetupVisible = !1),
      renderArchive(),
      scheduleArchivePoll(),
      toast("正在启动本机浏览器，Windows 会自动尝试 Chrome 或 Edge"));
  } catch (r) {
    ((n.textContent = r.message), (n.hidden = !1));
  } finally {
    ((e.disabled = !(state.archive?.available ?? !0)),
      (e.textContent = "打开浏览器并开始归档"));
  }
});
query("#cancelArchive").addEventListener("click", async () => {
  if (window.confirm("确定停止当前归档吗？已经保存成功的文章会保留。"))
    try {
      ((state.archive = await request("/api/wechat/archive/cancel", {
        method: "POST",
        body: "{}",
      })),
        renderArchive(),
        scheduleArchivePoll());
    } catch (t) {
      toast(t.message, !0);
    }
});
query("#openArchiveFolder").addEventListener("click", async () => {
  try {
    await request("/api/wechat/archive/open-folder", {
      method: "POST",
      body: "{}",
    });
  } catch (t) {
    toast(t.message, !0);
  }
});
query("#restartArchive").addEventListener("click", () => {
  ((state.archiveSetupVisible = !0),
    (query("#archiveAccountName").value = ""),
    renderArchive(),
    query("#archiveAccountName").focus());
});
query("#clearArchiveSession").addEventListener("click", async () => {
  try {
    ((state.archive = await request("/api/wechat/archive/session", {
      method: "DELETE",
    })),
      renderArchive(),
      toast("本机公众号登录信息已清除"));
  } catch (t) {
    toast(t.message, !0);
  }
});
query("#accountForm").addEventListener("submit", async (t) => {
  t.preventDefault();
  const e = query("#bindAccount"),
    n = query("#accountFormError");
  ((e.disabled = !0), (e.textContent = "正在验证…"), (n.hidden = !0));
  try {
    const r = await request("/api/wechat/accounts", {
      method: "POST",
      body: JSON.stringify({
        name: query("#accountName").value,
        app_id: query("#accountAppId").value,
        app_secret: query("#accountAppSecret").value,
      }),
    });
    (t.currentTarget.reset(),
      await loadAccounts(r.id),
      state.current && selectedAccount(),
      toast(`已绑定公众号：${r.name}`));
  } catch (r) {
    ((n.textContent = r.message), (n.hidden = !1));
  } finally {
    ((e.disabled = !1), (e.textContent = "验证并绑定"));
  }
});
query("#boundAccountList").addEventListener("click", async (t) => {
  const e = t.target.closest("[data-delete-account]"),
    n = state.accounts.find((r) => r.id === e?.dataset.deleteAccount);
  if (!(
    !e ||
    !n ||
    !window.confirm(`确定解除绑定“${n.name}”吗？本地稿件不会删除。`)
  ))
    try {
      (await request(`/api/wechat/accounts/${encodeURIComponent(n.id)}`, {
        method: "DELETE",
      }),
        await loadAccounts(),
        state.current?.metadata.wechat_account_id === n.id &&
          ((ui.accountSelect.value = ""), selectedAccount()),
        toast(`已解除绑定：${n.name}`));
    } catch (r) {
      toast(r.message, !0);
    }
});
document.querySelectorAll("[data-source-mode]").forEach((t) =>
  t.addEventListener("click", () => {
    showSourcePane(t.dataset.sourceMode);
  }),
);
ui.assetGrid.addEventListener("click", (t) => {
  const e = t.target.closest("[data-insert-asset]");
  if (!e?.dataset.insertAsset) return;
  const n = e.dataset.insertAsset;
  (insertMarkdown(`![${assetBasename(n).replace(/\.[^.]+$/, "")}](${n})`),
    toast("图片引用已插入正文"));
});
query("#themeSelect").addEventListener("change", (t) => {
  ((state.theme = t.currentTarget.value),
    typographyControls.themeChanged(state.theme),
    renderPreview(),
    setDirty(!0));
});
query("#paletteSelect").addEventListener("change", (t) => {
  ((state.palette = t.currentTarget.value),
    (query("#paletteSwatch").style.background =
      palettes[state.palette].primary),
    renderPreview(),
    setDirty(!0));
});
document.querySelectorAll("[data-preview]").forEach((t) =>
  t.addEventListener("click", () => {
    ((state.previewMode = t.dataset.preview),
      document
        .querySelectorAll("[data-preview]")
        .forEach((e) => e.classList.toggle("is-active", e === t)),
      renderPreview());
  }),
);
for (const t of [
  ui.titleInput,
  ui.authorInput,
  ui.digestInput,
  ui.sourceInput,
  ui.commentInput,
  ui.fansInput,
  ui.showCoverInput,
])
  (t.addEventListener("input", selectedAccount),
    t.addEventListener("change", selectedAccount));
query("#toggleDrafts").addEventListener("click", () =>
  document.body.classList.toggle("show-drafts"),
);
window.addEventListener("beforeunload", (t) => {
  if (state.dirty) recovery.flush().catch(() => {});
  state.dirty && t.preventDefault();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && state.dirty)
    recovery.flush().catch(() => {});
});
window.addEventListener("keydown", (t) => {
  (t.metaKey || t.ctrlKey) &&
    t.key.toLowerCase() === "s" &&
    (t.preventDefault(), saveDraft().then((e) => e && toast("稿件已保存")));
});
initialize();
export {
  legacyUnderscore as _,
  legacyA as a,
  legacyG as g,
  legacyK as k,
  previewWechatArticle,
  exportWechatArticle,
};
