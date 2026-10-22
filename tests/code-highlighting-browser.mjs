import {CODE_SAMPLES} from './code-samples.mjs';
import {publishedCodeText} from './published-code-text.mjs';
const results=[],report=document.querySelector('#code-report');
const check=(condition,label)=>{if(!condition)throw new Error(label);results.push('PASS '+label);};
const fence=(lang,code)=>'```'+lang+'\n'+code+'\n```';
function luminance(rgb){return rgb.match(/[\d.]+/g).slice(0,3).map(v=>{v=Number(v)/255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);}
function contrast(a,b){const x=luminance(a),y=luminance(b);return(Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);}
try {
  const entry=await fetch('/editor/',{cache:'no-store'}).then(r=>r.text());
  const script=new DOMParser().parseFromString(entry,'text/html').querySelector('script[type="module"][crossorigin]');
  const renderer=await import(script.getAttribute('src'));
  for(const theme of ['technical','journal','minimal','obsidian','deepsea','teal']) {
    // Verify the distinction on the actual publishing HTML, after class removal.
    const rich='import torch\n@torch.no_grad()\ndef infer(x: torch.Tensor, enabled=True):\n    label = "ROCm"\n    # Keep inference numerically stable\n    return torch.softmax(x / 0.5, dim=-1)\n';
    const richPreview=renderer.previewWechatArticle(fence('python',rich),theme,'blue',{});
    const parsed=new DOMParser().parseFromString(richPreview.html,'text/html');
    const richHost=document.createElement('article');richHost.innerHTML=renderer.exportWechatArticle(fence('python',rich),theme,'blue',{});document.body.append(richHost);
    const originalTokens=[...parsed.querySelectorAll('pre code span')],publishedTokens=[...richHost.querySelectorAll('pre code span:not([data-wx-code-indent])')];
    const roleColors={};
    for(const [role,selector] of Object.entries({keyword:'.hljs-keyword',decorator:'.hljs-meta',string:'.hljs-string',number:'.hljs-number',literal:'.hljs-literal',type:'.hljs-type',function:'.hljs-title.function_',api:'.hljs-built_in',parameter:'.hljs-params',comment:'.hljs-comment'})) {
      const token=parsed.querySelector('pre code '+selector),published=publishedTokens[originalTokens.indexOf(token)];
      check(!!token&&publishedCodeText(published)===token.textContent,theme+'/'+role+' survives inline publishing');
      roleColors[role]=getComputedStyle(published).color;
    }
    check(new Set(Object.values(roleColors)).size>=9,theme+' has at least nine distinct semantic colors');
    check(roleColors.function!==roleColors.api&&roleColors.keyword!==roleColors.decorator&&roleColors.type!==roleColors.number,theme+' separates function/API, keyword/decorator and type/number');
    check(Object.values(roleColors).every(color=>contrast(color,getComputedStyle(richHost.querySelector('pre')).backgroundColor)>=4.5),theme+' rich semantic colors remain readable');
    check(publishedCodeText(richHost.querySelector('pre code'))===rich,theme+' rich colors do not change code text');
    richHost.remove();
    for(const [lang,code] of Object.entries(CODE_SAMPLES)) {
      const markdown=fence(lang,code),options={code_wrap:'scroll'};
      const preview=renderer.previewWechatArticle(markdown,theme,'blue',options);
      const host=document.createElement('article');host.innerHTML=renderer.exportWechatArticle(markdown,theme,'blue',options);
      host.style.width='327px';document.body.append(host);
      const pre=host.querySelector('pre'),output=pre.querySelector('code'),tokens=[...output.querySelectorAll('span[style*="color"]')];
      check(publishedCodeText(output)===code,theme+'/'+lang+' original characters survive real export');
      check(!host.querySelector('[class],script,style,button,iframe'),theme+'/'+lang+' colors do not depend on classes or scripts');
      check(tokens.length>0,theme+'/'+lang+' tokens survive inline export');
      if(['python','tilelang','triton','cpp','hip','cuda'].includes(lang)) {
        const parsedCode=new DOMParser().parseFromString(preview.html,'text/html');
        const sourceSpans=[...parsedCode.querySelectorAll('pre code span')];
        const functionTitle=parsedCode.querySelector('.hljs-title.function_,.hljs-function .hljs-title');
        const publishedTitle=[...output.querySelectorAll('span:not([data-wx-code-indent])')][sourceSpans.indexOf(functionTitle)];
        check(!!publishedTitle&&Number(getComputedStyle(publishedTitle).fontWeight)>=600,theme+'/'+lang+' function names remain emphasized in publishing HTML');
      }
      check(publishedCodeText(new DOMParser().parseFromString(preview.html,'text/html').querySelector('pre code'))===code,theme+'/'+lang+' preview and export agree');
      check(getComputedStyle(output).fontSize==='12px'&&getComputedStyle(pre).tabSize==='4',theme+'/'+lang+' readable default code size and tabs');
      const bg=getComputedStyle(pre).backgroundColor;
      check(tokens.every(n=>contrast(getComputedStyle(n).color,bg)>=4.5),theme+'/'+lang+' every syntax token has at least 4.5:1 contrast');
      check(host.scrollWidth<=host.clientWidth+1,theme+'/'+lang+' stays within phone article');
      host.remove();
    }
    const long=CODE_SAMPLES.python+'result = "'+('AI_ROCM_'.repeat(40))+'"\n';
    for(const width of [278,327,690,744,820,1180])for(const mode of ['wrap','scroll']) {
      const host=document.createElement('article');host.style.width=width+'px';host.innerHTML=renderer.exportWechatArticle(fence('python',long),theme,'blue',{code_wrap:mode});document.body.append(host);
      const pre=host.querySelector('pre'),code=host.querySelector('pre code');
      check(publishedCodeText(code)===long && host.scrollWidth<=width+1,theme+'/'+width+'/'+mode+' contains complete long code');
      if(mode==='wrap')check(pre.scrollWidth<=pre.clientWidth+1,theme+'/'+width+' wrapped lines fit');
      else {pre.scrollLeft=pre.scrollWidth;check(pre.scrollLeft>0,theme+'/'+width+' long line can scroll to its end');}
      host.remove();
    }
  }
  for(const [title,theme,lang] of [['AMD 技术蓝 · TileLang','technical','tilelang'],['AMD 技术蓝 · PyTorch','technical','python'],['曜石青 · Triton','obsidian','triton'],['纸感期刊 · HIP','journal','hip'],['极简墨色 · PowerShell','minimal','powershell'],['AMD 技术蓝 · Bash','technical','bash']]) {
    const card=document.createElement('section');card.className='sample';const heading=document.createElement('h2');heading.textContent=title;card.append(heading);
    const article=document.createElement('article');article.innerHTML=renderer.exportWechatArticle(fence(lang,CODE_SAMPLES[lang]),theme,'blue',{code_wrap:'wrap'});card.append(article);document.querySelector('#code-gallery').append(card);
  }
  report.textContent=results.join('\n')+'\n'+results.length+' checks passed';report.dataset.result='pass';
}catch(error){report.textContent=results.join('\n')+'\nFAIL '+error.stack;report.dataset.result='fail';}
