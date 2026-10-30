import {canonicalAssetPath} from './asset-paths.mjs';

/** Resolve only this draft's material URLs, without changing its Markdown. */
export function resolvePreviewAssets(html,{document=globalThis.document,draftId,assets=[]}={}) {
 const root=document.createElement('div');root.innerHTML=html;
 const pathOf=source=>canonicalAssetPath(source,draftId,assets);
 const url=source=>{
  if(!draftId||/^(?:https?:|data:|blob:|\/\/)/i.test(source))return source;
  const path=pathOf(source);
  if(path.startsWith('/')||path.split('/').includes('..')||/[:\0\r\n]/.test(path))return source;
  const fragment=source.includes('#')?source.slice(source.indexOf('#')):'';
  return `/api/editor/drafts/${encodeURIComponent(draftId)}/assets/${path.split('/').map(encodeURIComponent).join('/')}${fragment}`;
 };
 for(const image of [...root.querySelectorAll('img[src]')]) {
  const asset=assets.find(a=>a.path===pathOf(image.getAttribute('src')));
  if(asset?.kind==='video') {
   const video=document.createElement('video');video.setAttribute('src',image.getAttribute('src'));
   if(image.getAttribute('alt'))video.setAttribute('aria-label',image.getAttribute('alt'));
   image.replaceWith(video);
  }
 }
 for(const media of root.querySelectorAll('img[src],video[src],audio[src],source[src]')) media.setAttribute('src',url(media.getAttribute('src')));
 for(const media of root.querySelectorAll('video[poster]')) media.setAttribute('poster',url(media.getAttribute('poster')));
 for(const media of root.querySelectorAll('video,audio')) {
  media.setAttribute('controls','');media.setAttribute('preload','metadata');media.removeAttribute('autoplay');
  media.style.cssText+=';display:block;max-width:100%;height:auto;margin:16px auto';
 }
 for(const anchor of root.querySelectorAll('a[href]')) {
  if(!/^(?:\.\/)?assets\//.test(anchor.getAttribute('href')))continue;
  anchor.setAttribute('href',url(anchor.getAttribute('href')));
  anchor.setAttribute('target','_blank');anchor.setAttribute('rel','noopener noreferrer');
 }
 return root.innerHTML;
}
