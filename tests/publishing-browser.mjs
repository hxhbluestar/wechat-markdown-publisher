import {publishedCodeText} from './published-code-text.mjs';
const report=document.querySelector('#report'), samples=document.querySelector('#samples');
const result={checks:0,failures:[]};
const check=(ok,label)=>{result.checks++;if(!ok)result.failures.push(label);};
const bash=['unset AITER_CONFIG_FMOE','BASE=$(python3 -c \'from aiter.jit.core import AITER_CONFIGS; print(AITER_CONFIGS.AITER_CONFIG_FMOE_FILE)\' | tail -n 1)','cp "$BASE" /work/fmoe_base.csv','cp "$BASE" /work/fmoe_candidate.csv','','python3 "$TUNER" \\','    -i /work/hy3_fmoe_shapes.csv \\','    -o /work/fmoe_candidate.csv \\','    --min_improvement_pct 3.0'].join('\n');
const snippets={bash,python:'def inference(x):\n\tif x is not None:\n\t\treturn x + 1\n\n# END',cpp:'int main() {\n    return 0;\n}',tilelang:'@T.prim_func\ndef main(A: T.Buffer):\n    with T.Kernel(1):\n        T.copy(A, B)',powershell:'$items = Get-ChildItem\nforeach ($item in $items) {\n    Write-Host $item.Name\n}'};
const articleThemes=['technical','journal','minimal','obsidian','deepsea','teal','grace','default','simple','nord','dracula','latte'];
const articlePalettes=['warm','blue','wechat','red','violet','ink'];
const autoCodeTheme=articleTheme=>articleTheme==='dracula'?'catppuccin':['technical','obsidian','deepsea','nord'].includes(articleTheme)?'vscode':'github';
const read=publishedCodeText;
const plainData='name,value\n"GPU, model",12\n\n  leading,14\n\t中文,16';
const plainLanguages=['csv','CSV','tsv','txt','text','plaintext','plain'];
// Real rich-text editors can discard all class/data attributes. The exported
// numbers have user-select:none inline, so read the retained source cells by
// that presentation rule rather than relying on private markers after cleaning.
const readCleanedCode=node=>node.nodeType===3?node.nodeValue:
 node.nodeType===1&&(/(?:^|;)\s*(?:-webkit-)?user-select\s*:\s*none(?:\s*!important)?\s*(?:;|$)/i.test(node.getAttribute('style')||''))?'':
 node.tagName==='BR'?'\n':[...node.childNodes].map(readCleanedCode).join('');
const codePalette={
 vscode:{body:'rgb(30, 30, 30)',header:'rgb(24, 24, 24)'},
 github:{body:'rgb(246, 248, 250)',header:'rgb(234, 238, 242)'},
 catppuccin:{body:'rgb(30, 30, 46)',header:'rgb(24, 24, 37)'},
};
const displayPython=['import torch','','@torch.inference_mode()','def infer(x: torch.Tensor, scale=0.125):','    # Keep the tensor on the GPU.','    logits = torch.matmul(x, x.T) * scale','    return torch.softmax(logits, dim=-1)'].join('\n');
const displayTileLang=['@T.prim_func','def matmul(A: T.Buffer, B: T.Buffer):','    with T.Kernel(128, threads=256) as bx:','        tile = T.alloc_shared((32, 64), "float16")','        T.copy(A[bx * 32, 0], tile)','        T.gemm(tile, B, C)'].join('\n');
const displayBash=['export HIP_VISIBLE_DEVICES=0','python3 benchmark.py \\','    --dtype float16 \\','    --output results.csv'].join('\n');
const showcaseMarkdown=['# 为 AI 工程而写的技术手记','正文样例：从张量到算子，让想法变成可以复现的实验。**专业排版与清晰语义**让复杂技术更容易阅读，参数 `batch_size` 保持醒目。参阅 [AMD ROCm 文档](https://rocm.docs.amd.com/)。','## 01 · 从可读代码开始','> 技术文章的美，来自内容的秩序：清晰的层级、舒服的留白，以及准确的每一个字符。','> [!TIP]\n> 保留原始代码和数据，记录实验条件，让读者能够复现结果。','### 推理路径 · Python','```python\n'+displayPython+'\n```','### Kernel 结构 · TileLang','```tilelang\n'+displayTileLang+'\n```','## 02 · 用数据解释结果','| 实验配置 | 说明 |\n| --- | --- |\n| GPU | AMD Instinct |\n| 精度 | float16 / bfloat16 |\n| 方法 | 预热后重复测量；本文数字仅作排版示例 |','<figure><section style="padding:18px 12px;border:1px solid #66899e;border-radius:8px;color:#234557;background:#e7f3f8;text-align:center;font-size:14px;line-height:1.8">GPU → Tensor → Kernel</section><figcaption>图 1 · 从张量到计算内核的执行路径</figcaption></figure>','### 可复现命令 · Bash','```bash\n'+displayBash+'\n```','CSV · 数据按原文显示，不显示行号。','```csv\nmodel,dtype,tokens_per_second\nROCm,float16,128.5\nROCm,bfloat16,126.8\n```'].join('\n\n');
const longHeadingMarkdown=showcaseMarkdown+'\n\n## 超长中文标题也应该自然换行且完整显示不裁切这是微信公众号技术文章排版验收的必要项目\n\n### ROCmGraphCompilerKernelConfigurationCrossPlatformPerformanceOptimizationWithoutClipping\n\n段落结束，完整字符可见。';
const rgb=color=>{const values=color.match(/[\d.]+/g)?.map(Number)||[];return [values[0]||0,values[1]||0,values[2]||0,values[3]??1];};
const effectiveBackground=node=>{
 let color=[255,255,255];const path=[];
 for(let current=node;current;current=current.parentElement)path.unshift(current);
 for(const element of path){const layer=rgb(getComputedStyle(element).backgroundColor);color=color.map((channel,index)=>layer[index]*layer[3]+channel*(1-layer[3]));}
 return color;
};
const luminance=channels=>channels.map(value=>value/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
const contrastRatio=node=>{
 const background=effectiveBackground(node),foreground=rgb(getComputedStyle(node).color);
 const text=background.map((channel,index)=>foreground[index]*foreground[3]+channel*(1-foreground[3]));
 const values=[luminance(text),luminance(background)].sort((a,b)=>a-b);return (values[1]+0.05)/(values[0]+0.05);
};
const hasUnsafePublishedContent=root=>!!root.querySelector('img[src^="http"],script,style,iframe,object,embed,foreignObject,a[href]')||
 [...root.querySelectorAll('*')].some(node=>node.getAttributeNames().some(name=>/^on/i.test(name)))||
 [...root.querySelectorAll('svg,svg *')].some(node=>!['svg','g','path','title','desc'].includes(node.tagName.toLowerCase())||node.getAttributeNames().some(name=>/(?:^|:)href$/i.test(name)&&!node.getAttribute(name).startsWith('#')));
let showcaseRenderer;
let activeArticleTheme='nord',activeCodeTheme='auto',activeCodeSize=12;
const renderShowcase=()=>{
 if(!showcaseRenderer)return;
 samples.style.width='393px';samples.style.padding='16px';
 samples.dataset.articleTheme=activeArticleTheme;samples.dataset.codeTheme=activeCodeTheme;samples.dataset.codeFontSize=String(activeCodeSize);
 samples.innerHTML=showcaseRenderer.exportWechatArticle(showcaseMarkdown,activeArticleTheme,'warm',{code_theme:activeCodeTheme,code_wrap:'wrap',code_font_size:activeCodeSize,caption_font_size:12,table_font_size:13});
 for(const button of document.querySelectorAll('[data-show-code-theme]')) button.setAttribute('aria-pressed',String(button.dataset.showCodeTheme===(activeCodeTheme==='auto'?autoCodeTheme(activeArticleTheme):activeCodeTheme)));
 for(const button of document.querySelectorAll('[data-show-article-theme]')) button.setAttribute('aria-pressed',String(button.dataset.showArticleTheme===activeArticleTheme));
 for(const button of document.querySelectorAll('[data-show-code-size]')) button.setAttribute('aria-pressed',String(Number(button.dataset.showCodeSize)===activeCodeSize));
 report.dataset.copyExpected=displayPython;
};
const showCodeTheme=codeTheme=>{
 activeCodeTheme=codeTheme;renderShowcase();
};
try {
 const entry=new DOMParser().parseFromString(await fetch('/editor/').then(r=>r.text()),'text/html');
 const renderer=await import(entry.querySelector('script[type="module"][crossorigin]').getAttribute('src'));
 const markdown=['# 技术文章','参数 `batch_size`，参考 [官方文档](https://example.com/docs?q=a&b=2)。','导入资料：[项目说明]https://github.com/ROCm/aiter/blob/main/README.md。',...Object.entries(snippets).map(([lang,source])=>'```'+lang+'\n'+source+'\n```'),'| 配置 | 示例 |\n| --- | --- |\n| 参数 | `dtype` 和 [源码](https://github.com/AMD-AIG/Hyperloom) |'].join('\n\n');
 for(const theme of articleThemes) for(const mode of ['scroll','wrap']) for(const codeSize of [12,14]) {
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
 const dataMarkdown=plainLanguages.map(language=>'```'+language+'\n'+plainData+'\n```').join('\n\n');
 const modernMarkdown=markdown+'\n\n'+dataMarkdown;
 const paletteFingerprints={};
 for(const codeTheme of Object.keys(codePalette)) for(const codeSize of [12,14]) for(const mode of ['wrap','scroll']) {
  const label='code-theme/'+codeTheme+'/'+codeSize+'/'+mode;
  const options={code_theme:codeTheme,code_font_size:codeSize,code_wrap:mode};
  samples.style.padding='16px';samples.style.width='393px';
  samples.innerHTML=renderer.exportWechatArticle(modernMarkdown,'technical','blue',options);
  const codes=[...samples.querySelectorAll('pre code')];
  check(codes.length===Object.keys(snippets).length+plainLanguages.length,label+' all programming and plain-data fences render');
  for(const [index,[language,source]] of Object.entries(snippets).entries()) {
   const code=codes[index],pre=code.closest('pre'),header=pre.previousElementSibling;
   check(read(code)===source,label+'/'+language+' exported source remains exact');
   check(code.querySelectorAll('[data-wx-code-line-number]').length===source.split('\n').length,label+'/'+language+' has one number for each logical source line');
   check([code,...code.querySelectorAll('*')].every(node=>parseFloat(getComputedStyle(node).fontSize)===codeSize),label+'/'+language+' all source, token and number text respects selected font size');
   check(getComputedStyle(pre).backgroundColor===codePalette[codeTheme].body,label+'/'+language+' code body uses requested independent theme');
   check(getComputedStyle(header).backgroundColor===codePalette[codeTheme].header,label+'/'+language+' header is visually distinct from body');
   check(getComputedStyle(pre).borderTopStyle==='solid'&&parseFloat(getComputedStyle(pre).borderTopWidth)>0,label+'/'+language+' real header divider survives CSS inlining');
   const tokenColors=new Set([...code.querySelectorAll('[style*="color"]')].filter(node=>node.textContent.trim()&&!node.hasAttribute('data-wx-code-line-number')&&!node.hasAttribute('data-wx-code-line-text')).map(node=>getComputedStyle(node).color));
   check(tokenColors.size>=3,label+'/'+language+' semantic highlighting contains at least three useful token colors');
   check(getComputedStyle(code).fontFamily.includes('monospace'),label+'/'+language+' has a device-safe monospace fallback');
   const fingerprint=[getComputedStyle(pre).backgroundColor,getComputedStyle(header).backgroundColor,...[...tokenColors].sort()].join('|');
   if(codeSize===12&&mode==='wrap') paletteFingerprints[codeTheme+'/'+language]=fingerprint;
  }
  for(const [index,language] of plainLanguages.entries()) {
   const code=codes[Object.keys(snippets).length+index];
   check(read(code)===plainData,label+'/'+language+' quotes, commas, tabs, empty lines and Unicode survive unchanged');
   check(!code.querySelector('[data-wx-code-line-number],[data-wx-code-line]'),label+'/'+language+' plain data has no line number or gutter');
   check(code.querySelectorAll('br').length===plainData.split('\n').length-1,label+'/'+language+' plain data uses explicit published line breaks');
  }
  if(mode==='wrap') for(const width of [320,393,690,820]) {
   samples.style.width=width+'px';
   check([...samples.querySelectorAll('pre,pre code')].every(node=>node.scrollWidth<=node.clientWidth+1),label+' programming and data blocks fit '+width+'px without horizontal clipping');
  }
  const expected=[...Object.values(snippets),...plainLanguages.map(()=>plainData)];
  for(const node of samples.querySelectorAll('*')) for(const name of node.getAttributeNames()) if(name==='class'||name.startsWith('data-')) node.removeAttribute(name);
  check(!samples.querySelector('[class],[data-wx-code-line],[data-wx-code-line-number]'),label+' cleaning removes every class and code marker');
  for(const [index,code] of [...samples.querySelectorAll('pre code')].entries()) {
   check(readCleanedCode(code)===expected[index],label+' sanitizer preserves code source '+index+' without leaking line numbers');
   check([code,...code.querySelectorAll('*')].every(node=>parseFloat(getComputedStyle(node).fontSize)===codeSize),label+' sanitizer retains '+codeSize+'px for block '+index);
  }
 }
 // Changing article colors/layout must not recolor an explicitly chosen code
 // theme. Compare every supported main language, not only the default text.
 for(const codeTheme of Object.keys(codePalette)) {
  samples.innerHTML=renderer.exportWechatArticle(markdown,'minimal','red',{code_theme:codeTheme,code_font_size:12,code_wrap:'wrap'});
  for(const [index,language] of Object.keys(snippets).entries()) {
   const code=samples.querySelectorAll('pre code')[index],pre=code.closest('pre'),header=pre.previousElementSibling;
   const tokenColors=new Set([...code.querySelectorAll('[style*="color"]')].filter(node=>node.textContent.trim()&&!node.hasAttribute('data-wx-code-line-number')&&!node.hasAttribute('data-wx-code-line-text')).map(node=>getComputedStyle(node).color));
   check([getComputedStyle(pre).backgroundColor,getComputedStyle(header).backgroundColor,...[...tokenColors].sort()].join('|')===paletteFingerprints[codeTheme+'/'+language],codeTheme+'/'+language+' explicit code palette remains independent of article layout and accent');
  }
 }
 for(const articleTheme of articleThemes) {
  samples.innerHTML=renderer.exportWechatArticle('```python\n'+snippets.python+'\n```',articleTheme,'blue',{code_theme:'auto'});
  check(getComputedStyle(samples.querySelector('pre')).backgroundColor===codePalette[autoCodeTheme(articleTheme)].body,articleTheme+' auto code theme chooses its documented safe default');
 }
 const newArticleLooks={};result.articleContrast=[];
 for(const theme of articleThemes) for(const palette of articlePalettes) {
  const label='article/'+theme+'/'+palette;
  samples.style.padding='16px';samples.style.width='393px';
  samples.innerHTML=renderer.exportWechatArticle(longHeadingMarkdown,theme,palette,{code_theme:'auto',code_font_size:12,code_wrap:'wrap',table_mode:'auto',caption_font_size:12,table_font_size:13});
  const prose=[...samples.querySelectorAll('p')].find(node=>node.textContent.startsWith('正文样例：'));
  const link=[...samples.querySelectorAll('span')].find(node=>node.textContent==='AMD ROCm 文档[1]');
  const quotation=samples.querySelector('blockquote p'),tableHeader=samples.querySelector('th');
  for(const [role,node] of [['body',prose],['link',link],['quote',quotation],['table-header',tableHeader]]) {
   const ratio=node?contrastRatio(node):0;
   check(ratio>=4.49,label+' '+role+' has readable contrast >=4.5:1 (actual '+ratio.toFixed(2)+')');
   result.articleContrast.push({theme,palette,role,contrast:Number(ratio.toFixed(3))});
  }
  if(['grace','default','simple'].includes(theme)&&palette==='warm') {
   result.legacyArticleDiagnostics??={};
   const inherited=[];
   for(let node=tableHeader;node;node=node.parentElement) inherited.push({tag:node.tagName,color:getComputedStyle(node).color,background:getComputedStyle(node).backgroundColor,style:node.getAttribute('style')});
   result.legacyArticleDiagnostics[theme]={
    header:tableHeader?.outerHTML,
    inheritedTableColors:inherited,
    unexpectedMarkup:[...samples.querySelectorAll('img[src^="http"],svg,script,style,a[href]')].map(node=>node.outerHTML.slice(0,1600)),
    widthDiagnostics:[],
   };
  }
  check(!!samples.querySelector('figcaption')&&getComputedStyle(samples.querySelector('figcaption')).fontSize==='12px',label+' real figure caption keeps the configured 12px size');
  check([...samples.querySelectorAll('pre code')].some(code=>read(code).startsWith('model,dtype,')&&!code.querySelector('[data-wx-code-line-number]')),label+' article CSV remains plain without a gutter');
  // A legacy TIP icon is a static SVG path, not executable content. Reject
  // active tags, event handlers and external SVG references instead of all SVG.
  check(!hasUnsafePublishedContent(samples),label+' synthetic showcase contains no external image or executable content');
  for(const width of [320,393,690,820]) {
   samples.style.width=width+'px';
   if(result.legacyArticleDiagnostics?.[theme]&&palette==='warm') result.legacyArticleDiagnostics[theme].widthDiagnostics.push({width,articleClient:samples.clientWidth,articleScroll:samples.scrollWidth,headings:[...samples.querySelectorAll('h1,h2,h3')].filter(node=>node.scrollWidth>node.clientWidth+1||node.scrollHeight>node.clientHeight+1).map(node=>({tag:node.tagName,text:node.textContent,client:node.clientWidth,scroll:node.scrollWidth,height:node.clientHeight,scrollHeight:node.scrollHeight,display:getComputedStyle(node).display,whiteSpace:getComputedStyle(node).whiteSpace,overflowWrap:getComputedStyle(node).overflowWrap,wordBreak:getComputedStyle(node).wordBreak,style:node.getAttribute('style')}))});
   check(samples.scrollWidth<=samples.clientWidth+1,label+' rich article does not widen '+width+'px viewport');
   check([...samples.querySelectorAll('h1,h2,h3')].every(node=>node.scrollWidth<=node.clientWidth+1&&node.scrollHeight<=node.clientHeight+1),label+' long CJK and English headings wrap completely at '+width+'px');
   check([...samples.querySelectorAll('pre,pre code')].every(node=>node.scrollWidth<=node.clientWidth+1),label+' code fits inside rich article at '+width+'px');
  }
  if(['nord','dracula','latte'].includes(theme)&&palette==='warm') {
   const h1=samples.querySelector('h1'),h2=samples.querySelector('h2'),quote=samples.querySelector('blockquote');
   const paper=h1.parentElement;
   const appearance=[getComputedStyle(paper).backgroundColor,getComputedStyle(h1).color,getComputedStyle(h1).borderTop,getComputedStyle(h1).borderBottom,getComputedStyle(h2).color,getComputedStyle(h2).backgroundColor,getComputedStyle(quote).backgroundColor,getComputedStyle(tableHeader).backgroundColor];
   newArticleLooks[theme]=appearance.join('|');
  }
 }
 result.newArticleLooks=newArticleLooks;
 check(Object.keys(newArticleLooks).length===3&&new Set(Object.values(newArticleLooks)).size===3,'three new article templates have distinct computed paper, heading, quote and table treatments');
 showcaseRenderer=renderer;renderShowcase();
}catch(error){result.failures.push(error.stack||String(error));}
document.body.dataset.results=JSON.stringify(result);
report.textContent=(result.failures.length?'FAIL':'PASS')+' · '+result.checks+' checks\n'+result.failures.slice(0,15).join('\n');
document.querySelector('#selectCodeSample').addEventListener('click',()=>{
 const range=document.createRange();range.selectNodeContents(samples.querySelector('pre code'));
 const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
});
for(const button of document.querySelectorAll('[data-show-code-theme]')) button.addEventListener('click',()=>showCodeTheme(button.dataset.showCodeTheme));
for(const button of document.querySelectorAll('[data-show-article-theme]')) button.addEventListener('click',()=>{activeArticleTheme=button.dataset.showArticleTheme;activeCodeTheme='auto';renderShowcase();});
for(const button of document.querySelectorAll('[data-show-code-size]')) button.addEventListener('click',()=>{activeCodeSize=Number(button.dataset.showCodeSize);renderShowcase();});
