const results=[],report=document.querySelector('#spacing-report');
const check=(ok,label)=>{if(!ok)throw new Error(label);results.push('PASS '+label);};
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"><rect width="640" height="240" fill="#e7f1ff"/><rect x="60" y="65" width="150" height="110" rx="8" fill="#0051c6"/><rect x="430" y="65" width="150" height="110" rx="8" fill="#07877f"/><path d="M230 120h180" stroke="#7c8da5" stroke-width="5"/><text x="135" y="130" text-anchor="middle" fill="white" font-family="Arial" font-size="24">GPU</text><text x="505" y="130" text-anchor="middle" fill="white" font-family="Arial" font-size="24">AI</text></svg>';
const image='data:image/svg+xml;base64,'+btoa(svg);
const raw='<p id="lead">这是一篇包含代码与图片的 AMD 技术文章。正文采用统一行距，长段落在手机上自然换行。</p><p id="second">第二段内容说明实验目标与配置，段间留白由同一处控制。</p><h2 id="heading" style="margin:80px 0;line-height:90px">二、GPU 推理性能与<strong style="line-height:80px">内核优化方法</strong></h2><p id="after-heading">标题下方的说明保持紧凑，不再与段落间距叠加。</p><figure id="figure" style="margin:60px 0"><p style="margin-bottom:50px"><img src="'+image+'" alt="实验架构示意图"></p><figcaption style="margin:40px"><p style="padding:20px">图 1：AMD GPU 与 AI 推理流程示意。图注采用 12px 字号，多行时也保持适当行距。</p></figcaption></figure><p id="after-figure">图片之后回到正文，图注下方只保留一份留白。</p>';
const find=(host,id)=>host.querySelector('[id="'+id+'"]');
try {
  const entry=await fetch('/editor/',{cache:'no-store'}).then(r=>r.text()),script=new DOMParser().parseFromString(entry,'text/html').querySelector('script[type="module"][crossorigin]');
  const renderer=await import(script.getAttribute('src'));
  for(const theme of ['technical','journal','minimal','obsidian','deepsea','teal'])for(const width of [278,344,393,690,744,820,1180]) {
    const host=document.createElement('article');host.style.width=width+'px';host.innerHTML=renderer.exportWechatArticle(raw,theme,'blue',{caption_font_size:12});document.body.append(host);
    const lead=find(host,'lead'),second=find(host,'second'),heading=find(host,'heading'),afterHeading=find(host,'after-heading'),figure=find(host,'figure'),afterFigure=find(host,'after-figure'),caption=figure.querySelector('figcaption'),img=figure.querySelector('img');
    const near=(a,b)=>Math.abs(a-b)<1;
    check(near(second.getBoundingClientRect().top-lead.getBoundingClientRect().bottom,16),theme+'/'+width+' paragraph gap is16px');
    check(near(heading.getBoundingClientRect().top-second.getBoundingClientRect().bottom,28),theme+'/'+width+' heading leading gap is28px');
    check(near(afterHeading.getBoundingClientRect().top-heading.getBoundingClientRect().bottom,12),theme+'/'+width+' heading trailing gap is12px');
    check(near(afterFigure.getBoundingClientRect().top-figure.getBoundingClientRect().bottom,20),theme+'/'+width+' figure trailing gap is20px');
    check(near(parseFloat(getComputedStyle(caption).paddingTop),8)&&getComputedStyle(caption).margin==='0px',theme+'/'+width+' caption owns just8px leading space');
    check(near(caption.getBoundingClientRect().top-img.getBoundingClientRect().bottom,0),theme+'/'+width+' image has no baseline or paragraph gap');
    check(near(parseFloat(getComputedStyle(caption).lineHeight),19.8)&&getComputedStyle(caption.querySelector('p')).padding==='0px',theme+'/'+width+' multi-line12px caption has stable line spacing');
    check(near(parseFloat(getComputedStyle(lead).lineHeight),parseFloat(getComputedStyle(lead).fontSize)*1.8),theme+'/'+width+' body line height is1.8');
    check(getComputedStyle(heading).lineHeight===getComputedStyle(heading.querySelector('strong')).lineHeight,theme+'/'+width+' heading inline text inherits line height');
    check(host.scrollWidth<=host.clientWidth+1,theme+'/'+width+' no horizontal clipping');
    check(!host.querySelector('[class],style,script,.wx-proofreading-error'),theme+'/'+width+' publishing needs no editor decorations');
    host.remove();
  }
  for(const theme of ['technical','journal']) {
    const card=document.createElement('section');card.className='spacing-sample';const heading=document.createElement('h2');heading.textContent=theme==='technical'?'AMD 技术蓝':'纸感期刊';card.append(heading);const host=document.createElement('article');host.innerHTML=renderer.exportWechatArticle(raw,theme,'blue',{caption_font_size:12});card.append(host);document.querySelector('#spacing-gallery').append(card);
  }
  report.dataset.status='passed';report.textContent=results.join('\n')+'\n'+results.length+' checks passed';
}catch(error){report.dataset.status='failed';report.textContent=results.join('\n')+'\nFAIL '+error.stack;}
