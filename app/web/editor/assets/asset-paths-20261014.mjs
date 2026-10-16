export function canonicalAssetPath(source, draftId = '') {
  const prefix = draftId ? `/api/editor/drafts/${draftId}/assets/` : '';
  if (prefix && source.startsWith(prefix)) source = source.slice(prefix.length);
  if (/^(?:https?:|data:|blob:|\/\/)/i.test(source)) return source;
  let clean;
  try { clean = decodeURIComponent(source).replace(/\\/g, '/').trim(); }
  catch { return source; }
  const parts = clean.split('/').filter(part => part && part !== '.');
  if (!clean || clean.startsWith('/') || /[:\0\r\n]/.test(clean) || parts.includes('..')) return source;
  clean = parts.join('/');
  if (!/\.(?:jpe?g|png|gif|webp)$/i.test(clean)) return source;
  return clean.startsWith('images/') || /^cover\.(?:jpe?g|png|gif|webp)$/i.test(clean)
    ? clean : `images/${clean}`;
}

export function imageUploadTarget(name, references, draftId = '') {
  const matches = [...new Set(references.map(path => canonicalAssetPath(path, draftId)))]
    .filter(path => !/^(?:https?:|data:|blob:|\/\/)/i.test(path) && path.split('/').pop() === name);
  if (matches.length > 1) throw new Error(`正文存在多个同名图片 ${name}，请先明确对应的素材路径`);
  if (matches.length === 1) return { path: matches[0], insert: false };
  return { path: `images/${name}`, insert: true };
}

export function missingImagePaths(references, assets, draftId = '') {
  const available = new Set(assets.map(asset => asset.path));
  return references.map(path => canonicalAssetPath(path, draftId))
    .filter(path => !/^(?:https?:|data:|blob:|\/\/)/i.test(path) && !available.has(path));
}
