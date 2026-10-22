const report=document.querySelector('#report'), samples=document.querySelector('#samples');
const result={checks:0,failures:[]};
const check=(ok,label)=>{result.checks++;if(!ok)result.failures.push(label);};
const bash=['unset AITER_CONFIG_FMOE','BASE=$(python3 -c \'from aiter.jit.core import AITER_CONFIGS; print(AITER_CONFIGS.AITER_CONFIG_FMOE_FILE)\' | tail -n 1)','cp "$BASE" /work/fmoe_base.csv','cp "$BASE" /work/fmoe_candidate.csv','','python3 "$TUNER" \\','    -i /work/hy3_fmoe_shapes.csv \\','    -o /work/fmoe_candidate.csv \\','    --min_improvement_pct 3.0'].join('\n');
const snippets={bash,python:'def inference(x):\n\tif x is not None:\n\t\treturn x + 1\n\n# END',cpp:'int main() {\n    return 0;\n}',tilelang:'@T.prim_func\ndef main(A: T.Buffer):\n    with T.Kernel(1):\n        T.copy(A, B)',powershell:'$items = Get-ChildItem\nforeach ($item in $items) {\n    Write-Host $item.Name\n}'};
const read=node=>node.nodeType===3?node.nodeValue:node.tagName==='BR'?'\n':[...node.childNodes].map(read).join('');
try {
 const entry=new DOMParser().parseFromString(await fetch('/editor/').then(r=>r.text()),'text/html');
 const renderer=await import(entry.querySelector('script[type="module"][crossorigin]').getAttribute('src'));
 const markdown=['# 技术文章','参数 `batch_size`，参考 [官方文档](https://example.com/docs?q=a&b=2)。',...Object.entries(snippets).map(([lang,source])=>'```'+lang+'\n'+source+'\n```'),'| 配置 | 示例 |\n| --- | --- |\n| 参数 | `dtype` 和 [源码](https://github.com/AMD-AIG/Hyperloom) |'].join('\n\n');
 for(const theme of ['technical','journal','minimal','obsidian','deepsea','teal','grace','default','simple']) for(const mode of ['scroll','wrap']) {
  const label=theme+'/'+mode, options={font_size:18,table_font_size:16,code_wrap:mode};
  const preview=renderer.previewWechatArticle(markdown,theme,'blue',options);
  const previewRoot=new DOMParser().parseFromString(preview.html,'text/html');
  check(!previewRoot.querySelector('a[href^="http"]'),label+' preview has no clickable external URL');
  check(Object.values(snippets).every(source=>[...previewRoot.querySelectorAll('pre code')].some(code=>read(code).replace(/\u00a0/g,' ').replace(/\t/g,'    ')===source.replace(/\t/g,'    '))),label+' preview preserves every original code line and indentation');
  samples.innerHTML=renderer.exportWechatArticle(markdown,theme,'blue',options);
  check(!samples.querySelector('[class],style,script,a[href]'),label+' export is inline markup with nonclickable links');
  check(samples.textContent.includes('官方文档（https://example.com/docs?q=a&b=2）'),label+' full external URL remains visible for copying');
  const link=[...samples.querySelectorAll('span')].find(e=>e.textContent==='官方文档（https://example.com/docs?q=a&b=2）');
  check(link && getComputedStyle(link).textDecorationLine.includes('underline'),label+' external text retains underline');
  for(const code of samples.querySelectorAll('code')) {
   const block=code.closest('pre'), size=block?14:12;
   check([code,...code.querySelectorAll('*')].every(e=>parseFloat(getComputedStyle(e).fontSize)===size),label+' code computes to '+size+'px including colored tokens and table content');
  }
  for(const [index,source] of Object.values(snippets).entries()) {
   const code=samples.querySelectorAll('pre code')[index];
   check(read(code)===source,label+' export preserves every original character including ASCII spaces and tabs of code '+index);
   check(code.querySelectorAll('br').length===source.split('\n').length-1,label+' code '+index+' has explicit line breaks');
  }
  // Reproduce the reported failure: ignore white-space CSS and replace pre with
  // a normal section, as a rich-text editor can do. Line layout must survive.
  for(const node of samples.querySelectorAll('pre,pre *')) node.style.removeProperty('white-space');
  for(const pre of [...samples.querySelectorAll('pre')]) {
   const section=document.createElement('section'); section.style.cssText=pre.style.cssText;
   while(pre.firstChild)section.append(pre.firstChild); pre.replaceWith(section);
  }
  const code=[...samples.querySelectorAll('code')].find(e=>e.querySelector('br'));
  check(code.innerText.split('\n').map(line=>line.trim()).join('\n').trimEnd()===bash.split('\n').map(line=>line.trim()).join('\n').trimEnd(),label+' Bash lines remain separate after whitespace styles are stripped');
  check([...code.querySelectorAll('[data-wx-code-indent]')].every(e=>e.getBoundingClientRect().width>0),label+' indentation has real width even without whitespace CSS');
  const colors=new Set([...code.querySelectorAll('*')].filter(e=>e.textContent.trim()).map(e=>getComputedStyle(e).color));
  check(colors.size>1,label+' syntax colors survive the publishing transform');
  if(label==='grace/scroll') result.legacySnippet=code.outerHTML;
 }
 samples.innerHTML=renderer.exportWechatArticle('## 微信代码显示\n\n```bash\n'+bash+'\n```\n\n参数 `batch_size`，参考 [官方文档](https://example.com/docs)。','technical','blue',{code_wrap:'wrap'});
}catch(error){result.failures.push(error.stack||String(error));}
document.body.dataset.results=JSON.stringify(result);
report.textContent=(result.failures.length?'FAIL':'PASS')+' · '+result.checks+' checks\n'+result.failures.slice(0,15).join('\n');
