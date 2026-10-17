import {build} from 'esbuild';
import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

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
const copy=async(src,dest)=>copyFile(path.join(root,src),path.join(root,dest));
for(const [src,dest] of [
  ['frontend/asset-paths.mjs','asset-paths-20261014.mjs'],
  ['frontend/article-spacing.mjs','article-spacing-20261017-scroll.mjs'],
  ['frontend/scroll-sync.mjs','scroll-sync-20261017-scroll.mjs'],
  ['frontend/proofreading.css','proofreading-20261017-scroll.css'],
  ['frontend/workflow-ui.css','workflow-ui-20261018.css'],
  ['frontend/authoring-tools.css','authoring-tools-20261018.css'],
  ['frontend/asset-tools.css','asset-tools-20261018.css'],
  ['frontend/sync-progress.css','sync-progress-20261018.css'],
  ['frontend/proofreading-dictionary.mjs','proofreading-dictionary-20261017-scroll.mjs'],
  ['frontend/typography-controls.css','typography-controls-20261017-scroll.css'],
  ['frontend/rocm-import.mjs','rocm-import-20261017.mjs'],
  ['frontend/company-network.mjs','company-network-20261016.mjs'],
  ['frontend/company-network.css','company-network-20261016.css'],
])await copy(src,'app/web/editor/assets/'+dest);
for(const [name,dependency] of [['typography','article-spacing'],['typography-controls','typography'],['proofreading','proofreading-core'],['proofreading-core','proofreading-dictionary']]){
  const content=await readFile(path.join(root,'frontend',name+'.mjs'),'utf8');
  await writeFile(path.join(assets,name+'-20261017-scroll.mjs'),content.replaceAll(`'./${dependency}.mjs'`,`'./${dependency}-20261017-scroll.mjs'`));
}
await copy('frontend/code-languages.js','app/web/vendor/highlight-ai-20261017.js');
await mkdir(path.join(root,'app/web/vendor/mathjax-3.2.2'),{recursive:true});
await copy('node_modules/mathjax/es5/tex-svg.js','app/web/vendor/mathjax-3.2.2/tex-svg.js');
await copy('node_modules/mathjax/LICENSE','app/web/vendor/mathjax-3.2.2/LICENSE');
const page=await readFile(path.join(root,'frontend/index.template.html'),'utf8');
await writeFile(path.join(root,'app/web/editor/index.html'),page.replace('src="/editor/assets/index-CIPbZpsp.js"','src="/editor/assets/index-20261018-workflow.js"').replace('"/editor/assets/index-20261017-scroll.js"','"/editor/assets/index-20261018-workflow.js"'));
console.log('Frontend built from readable application sources and pinned renderer runtime.');
