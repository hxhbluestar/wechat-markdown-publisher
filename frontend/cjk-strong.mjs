import {scanCodeRegions} from './technical-writing.mjs';

/** Render-only compatibility for plain CJK labels such as **性能：**395.
 * CommonMark treats the closing punctuation/Latin boundary as non-closing.
 * Keep authored Markdown, code and complex inline syntax unchanged.
 */
export function prepareCjkStrong(source) {
 const {mask}=scanCodeRegions(source);
 for(const match of source.matchAll(/<[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|!?\[[^\]\r\n]*\]\((?:\\.|[^)\\])*\)|\b(?:https?|file):[^\s<>]+/g))mask.fill(1,match.index,match.index+match[0].length);
 const pattern=/\*\*([\p{L}\p{N}][\p{L}\p{N} \t，、；：。！？（）【】《》“”‘’,:;.!?()/+\-]{0,119}[，、；：。！？）】》”’])\*\*(?=[A-Za-z0-9])/gu;
 return source.replace(pattern,(whole,label,at)=>{
  if(source[at-1]==='*'||mask.slice(at,at+whole.length).some(Boolean))return whole;
  let slashes=0;for(let i=at-1;i>=0&&source[i]==='\\';i--)slashes++;
  return slashes%2?whole:`<strong>${label}</strong>`;
 });
}
