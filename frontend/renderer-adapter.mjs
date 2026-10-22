import { BS, MS, J8, AS, kd } from "./vendor/editor-engine-20261018.js";
import { prepareTypography, typographyAccent, typographyCodeColors } from "./typography.mjs";
import { preparePublishingPresentation, preserveWechatCodeLayout } from "./publishing-presentation.mjs";
import { applyBlockOverrides } from "./article-blocks.mjs";
import { prepareRichMarkdown } from "./rich-content.mjs";
const lexer = new AS();
export const lexArticleMarkdown = (text) => {
  const { markdownContent: content } = kd.parseFrontMatterAndContent(text);
  return { content, tokens: lexer.lexer(content) };
};
export const renderMarkdownSource = (markdown) =>
  BS(prepareRichMarkdown(markdown));
export function stripExportDecorations(html, document = globalThis.document) {
  const host = document.createElement("div");
  host.innerHTML = html;
  for (const node of host.querySelectorAll(".mac-sign,.wx-alert-title svg"))
    node.remove();
  return host.innerHTML;
}

export function previewWechatArticle(
  markdown,
  theme,
  palette = "warm",
  options = {},
) {
  const raw =
    typeof options.richHtml === "string"
      ? options.richHtml
      : renderMarkdownSource(markdown);
  const result = prepareTypography(raw, { ...options, theme, palette });
  const blocks = applyBlockOverrides(
    result.html,
    markdown,
    options.block_overrides,
    {
      document: options.document || globalThis.document,
      lexMarkdown: lexArticleMarkdown,
      annotate: !!options.annotate,
    },
  );
  return {
    html: preparePublishingPresentation(blocks.html, {
      document: options.document || globalThis.document,
      linkColor: typographyAccent(theme,palette) || '#576b95',
      codeColors: ['grace','default','simple'].includes(theme) ? typographyCodeColors(theme) : undefined,
    }),
    unmatched: blocks.unmatched,
    css:
      MS(
        ["grace", "default", "simple"].includes(theme) ? theme : "default",
        palette,
      ) +
      "\n" +
      result.css,
  };
}
export function exportWechatArticle(
  markdown,
  theme,
  palette = "warm",
  options = {},
) {
  const preview = previewWechatArticle(markdown, theme, palette, {
    ...options,
    annotate: false,
  });
  return preserveWechatCodeLayout(J8.inlineContent(
    `<section id="output">${stripExportDecorations(preview.html, options.document || globalThis.document)}</section>`,
    preview.css,
    {
      inlinePseudoElements: true,
      preserveImportant: true,
      resolveCSSVariables: true,
      removeStyleTags: true,
    },
  ), options.document || globalThis.document)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/\sid="output"/g, "")
    .replace(
      /\sdata-(?:source-code|raw-code|language-pending|show-line-number|article-block|rich-source-from|rich-source-to)="[^"]*"/g,
      "",
    )
    .replace(/\sclass="[^"]*"/g, "")
    .replace(/<a([^>]+)href="#(?:[^"']*)"([^>]*)>/g, "<a$1$2>");
}
