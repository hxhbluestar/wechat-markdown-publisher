import {publishedCodeText} from './published-code-text.mjs';
const report=document.querySelector('#report'), samples=document.querySelector('#samples');
const result={checks:0,failures:[]};
const check=(ok,label)=>{result.checks++;if(!ok)result.failures.push(label);};
const bash=['unset AITER_CONFIG_FMOE','BASE=$(python3 -c \'from aiter.jit.core import AITER_CONFIGS; print(AITER_CONFIGS.AITER_CONFIG_FMOE_FILE)\' | tail -n 1)','cp "$BASE" /work/fmoe_base.csv','cp "$BASE" /work/fmoe_candidate.csv','','python3 "$TUNER" \\','    -i /work/hy3_fmoe_shapes.csv \\','    -o /work/fmoe_candidate.csv \\','    --min_improvement_pct 3.0'].join('\n');
const snippets={bash,python:'def inference(x):\n\tif x is not None:\n\t\treturn x + 1\n\n# END',cpp:'int main() {\n    return 0;\n}',tilelang:'@T.prim_func\ndef main(A: T.Buffer):\n    with T.Kernel(1):\n        T.copy(A, B)',powershell:'$items = Get-ChildItem\nforeach ($item in $items) {\n    Write-Host $item.Name\n}'};
const read=publishedCodeText;
try {
 const entry=new DOMParser().parseFromString(await fetch('/editor/').then(r=>r.text()),'text/html');
 const renderer=await import(entry.querySelector('script[type="module"][crossorigin]').getAttribute('src'));
 const markdown=['# 技术文章','参数 `batch_size`，参考 [官方文档](https://example.com/docs?q=a&b=2)。','导入资料：[项目说明]https://github.com/ROCm/aiter/blob/main/README.md。',...Object.entries(snippets).map(([lang,source])=>'```'+lang+'\n'+source+'\n```'),'| 配置 | 示例 |\n| --- | --- |\n| 参数 | `dtype` 和 [源码](https://github.com/AMD-AIG/Hyperloom) |'].join('\n\n');
 for(const theme of ['technical','journal','minimal','obsidian','deepsea','teal','grace','default','simple']) for(const mode of ['scroll','wrap']) for(const codeSize of [12,14]) {
  const label=theme+'/'+mode+'/'+codeSize, options={font_size:18,table_font_size:16,code_wrap:mode,code_font_size:codeSize};
  const preview=renderer.previewWechatArticle(markdown,theme,'blue',options);
  const previewRoot=new DOMParser().parseFromString(preview.html,'text/html');
  check(!previewRoot.querySelector('a[href^="http"]'),label+' preview has no clickable external URL');
  check(Object.values(snippets).every(source=>[...previewRoot.querySelectorAll('pre code')].some(code=>read(code).replace(/\u00a0/g,' ').replace(/\t/g,'    ')===source.replace(/\t/g,'    '))),label+' preview preserves every original code line and indentation');
  samples.innerHTML=renderer.exportWechatArticle(markdown,theme,'blue',options);
  check(!samples.querySelector('[class],style,script,a[href]'),label+' export is inline markup with nonclickable links');
  check(samples.textContent.includes('https://example.com/docs?q=a&b=2') && !samples.querySelector('p').textContent.includes('https://'),label+' full URL is in references without expanding prose');
  const link=[...samples.querySelectorAll('span')].find(e=>e.textContent==='官方文档[1]');
  check(link && getComputedStyle(link).textDecorationLine.includes('underline'),label+' external text retains underline');
  check([...samples.querySelectorAll('span')].some(e=>e.textContent==='项目说明[2]'),label+' imported plain label-URL is compact too');
  for(const code of samples.querySelectorAll('code')) {
   const block=code.closest('pre'), size=block?codeSize:12;
   check([code,...code.querySelectorAll('*')].every(e=>parseFloat(getComputedStyle(e).fontSize)===size),label+' code computes to '+size+'px including colored tokens and table content');
  }
  for(const pre of samples.querySelectorAll('pre')) {
   const title=pre.previousElementSibling;
   check(title?.tagName==='SECTION' && getComputedStyle(title).fontSize==='12px',label+' language header has its own real 12px element');
   // Browser zoom/DPR may quantize a declared 1px border below one CSS pixel.
   check(getComputedStyle(pre).borderTopStyle==='solid' && parseFloat(getComputedStyle(pre).borderTopWidth)>0 && /border-top:\s*1px solid/.test(pre.getAttribute('style')),label+' published separator is present on code body');
  }
  if(mode==='wrap') for(const width of [320,393,690,820]) {
   samples.style.width=width+'px';samples.style.boxSizing='border-box';
   check([...samples.querySelectorAll('pre,pre code')].every(e=>e.scrollWidth<=e.clientWidth+1),label+' no clipped code at '+width+'px');
   check(samples.scrollWidth<=samples.clientWidth+1,label+' references do not widen article at '+width+'px');
  }
  for(const [index,source] of Object.values(snippets).entries()) {
   const code=samples.querySelectorAll('pre code')[index];
   check(read(code)===source,label+' export preserves every original character including ASCII spaces and tabs of code '+index);
   check(code.querySelectorAll('br').length===source.split('\n').length-1,label+' code '+index+' has explicit line breaks');
   check([...code.querySelectorAll('[data-wx-code-line-number]')].map(e=>e.textContent).join(',')===source.split('\n').map((_,i)=>i+1).join(','),label+' original logical lines have one line number each');
  }
  // Reproduce the reported failure: ignore white-space CSS and replace pre with
  // a normal section, as a rich-text editor can do. Line layout must survive.
  for(const node of samples.querySelectorAll('pre,pre *')) node.style.removeProperty('white-space');
  for(const pre of [...samples.querySelectorAll('pre')]) {
   const section=document.createElement('section'); section.style.cssText=pre.style.cssText;
   while(pre.firstChild)section.append(pre.firstChild); pre.replaceWith(section);
  }
  const code=[...samples.querySelectorAll('code')].find(e=>e.querySelector('br'));
  check([...code.querySelectorAll('[data-wx-code-line-text]')].map(e=>e.innerText.trim()).join('\n').trimEnd()===bash.split('\n').map(line=>line.trim()).join('\n').trimEnd(),label+' Bash lines remain separate after whitespace styles are stripped');
  check([...code.querySelectorAll('[data-wx-code-indent]')].every(e=>e.getBoundingClientRect().width>0),label+' indentation has real width even without whitespace CSS');
  const colors=new Set([...code.querySelectorAll('*')].filter(e=>e.textContent.trim()).map(e=>getComputedStyle(e).color));
  check(colors.size>1,label+' syntax colors survive the publishing transform');
  if(label==='grace/scroll/12') result.legacySnippet=code.outerHTML;
 }
 samples.style.width='393px';samples.style.padding='16px';
 samples.innerHTML=renderer.exportWechatArticle('## AITER 调优示例\n\n参考 [AITER 项目说明](https://github.com/ROCm/aiter/blob/main/README.md)、[官方调优脚本](https://github.com/ROCm/aiter/blob/main/.github/scripts/op_tune.sh)。\n\n```bash\n'+bash+'\n```\n\n代码 12px · 长命令自动换行 · 参数 `batch_size`','technical','blue',{code_wrap:'wrap',code_font_size:12});
}catch(error){result.failures.push(error.stack||String(error));}
document.body.dataset.results=JSON.stringify(result);
report.textContent=(result.failures.length?'FAIL':'PASS')+' · '+result.checks+' checks\n'+result.failures.slice(0,15).join('\n');
document.querySelector('#selectCodeSample').addEventListener('click',()=>{
 const range=document.createRange();range.selectNodeContents(samples.querySelector('pre code'));
 const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
});
report.dataset.copyExpected=bash;
