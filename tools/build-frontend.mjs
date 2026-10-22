import {build} from 'esbuild';
import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const assets=path.join(root,'app/web/editor/assets');
await build({
  absWorkingDir:root,entryPoints:['frontend/editor-app.mjs'],
  outfile:path.join(assets,'index-20261018-workflow.js'),
  bundle:true,format:'esm',target:'es2022',minify:true,legalComments:'eof',external:['/editor/assets/*'],
  plugins:[{name:'pinned-renderer-chunks',setup(api){
    api.onResolve({filter:/^\.\/.+\.js$/},args=>{
      if(args.importer.replaceAll('\\','/').endsWith('frontend/vendor/editor-engine-20261018.js'))
        return {path:'./'+path.basename(args.path),external:true};
    });
  }}],
});
await copyFile(path.join(assets,'index-20261018-workflow.js'),path.join(assets,'index-20261017-scroll.js'));
// Git checks these text resources out as LF. Editors on Windows can save CRLF;
// normalize before writing and hashing so a clean checkout builds the same page.
const readText=async(filename)=>(await readFile(filename,'utf8')).replaceAll('\r\n','\n');
const copy=async(src,dest)=>writeFile(path.join(root,dest),await readText(path.join(root,src)));
for(const [src,dest] of [
  ['frontend/asset-paths.mjs','asset-paths-20261014.mjs'],
  ['frontend/code-themes.mjs','code-themes-20261022.mjs'],
  ['frontend/article-spacing.mjs','article-spacing-20261017-scroll.mjs'],
  ['frontend/scroll-sync.mjs','scroll-sync-20261017-scroll.mjs'],
  ['frontend/proofreading.css','proofreading-20261017-scroll.css'],
  ['frontend/workflow-ui.css','workflow-ui-20261018.css'],
  ['frontend/authoring-tools.css','authoring-tools-20261018.css'],
  ['frontend/asset-tools.css','asset-tools-20261018.css'],
  ['frontend/sync-progress.css','sync-progress-20261018.css'],
  ['frontend/editor-layout.css','editor-layout-20261018.css'],
  ['frontend/proofreading-dictionary.mjs','proofreading-dictionary-20261017-scroll.mjs'],
  ['frontend/typography-controls.css','typography-controls-20261017-scroll.css'],
  ['frontend/rocm-import.mjs','rocm-import-20261017.mjs'],
  ['frontend/company-network.mjs','company-network-20261016.mjs'],
  ['frontend/company-network.css','company-network-20261016.css'],
])await copy(src,'app/web/editor/assets/'+dest);
for(const [name,dependency] of [['typography','article-spacing'],['typography-controls','typography'],['proofreading','proofreading-core'],['proofreading-core','proofreading-dictionary']]){
  const content=await readText(path.join(root,'frontend',name+'.mjs'));
  await writeFile(path.join(assets,name+'-20261017-scroll.mjs'),content.replaceAll(`'./${dependency}.mjs'`,`'./${dependency}-20261017-scroll.mjs'`).replaceAll("'./code-themes.mjs'","'./code-themes-20261022.mjs'"));
}
await copy('frontend/code-languages.js','app/web/vendor/highlight-ai-20261017.js');
await mkdir(path.join(root,'app/web/vendor/mathjax-3.2.2'),{recursive:true});
await copy('node_modules/mathjax/es5/tex-svg.js','app/web/vendor/mathjax-3.2.2/tex-svg.js');
await copy('node_modules/mathjax/LICENSE','app/web/vendor/mathjax-3.2.2/LICENSE');
let page=await readText(path.join(root,'frontend/index.template.html'));
page=page.replace('src="/editor/assets/index-CIPbZpsp.js"','src="/editor/assets/index-20261018-workflow.js"').replace('"/editor/assets/index-20261017-scroll.js"','"/editor/assets/index-20261018-workflow.js"');
// A page query parameter does not change the identity of its subresources.
// Stable content digests invalidate old browser entries without timestamps or
// deleting the user's browser data. Replace the import-map target as well, so
// renderer chunks reuse the exact same application module instance.
const resources=new Set([...page.matchAll(/(?:src|href)="(\/[^"?]+\.(?:css|mjs|js))"/g)].map(match=>match[1]));
for(const resource of resources){
  const bytes=await readFile(path.join(root,'app/web',resource.slice(1)));
  const digest=createHash('sha256').update(bytes).digest('hex').slice(0,16);
  page=page.replaceAll('"'+resource+'"','"'+resource+'?v='+digest+'"');
}
const release=JSON.parse(await readFile(path.join(root,'packaging/version.json'),'utf8')).version;
if(!/^[a-z0-9.-]+$/i.test(release))throw new Error('Invalid frontend release version');
page=page.replace('<head>','<head>\n  <meta name="publisher-build" content="'+release+'">');
await writeFile(path.join(root,'app/web/editor/index.html'),page);
console.log('Frontend built from readable application sources and pinned renderer runtime.');
