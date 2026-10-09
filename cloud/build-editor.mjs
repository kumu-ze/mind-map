import { cp,readFile,writeFile,mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
execFileSync(process.execPath,[path.join(root,'web/node_modules/@vue/cli-service/bin/vue-cli-service.js'),'build'],{
 cwd:path.join(root,'web'),stdio:'inherit',env:{...process.env,KONON_CLOUD_BUILD:'1',NODE_OPTIONS:'--openssl-legacy-provider'}
});
await cp(path.join(root,'cloud/editor-adapter.js'),path.join(root,'cloud/editor/adapter.js'));
await cp(path.join(root,'cloud/editor-theme.css'),path.join(root,'cloud/editor/theme.css'));
// Preserve preview files referenced by the editor even when the legacy asset pipeline omits them.
await mkdir(path.join(root,'cloud/editor/img'),{recursive:true});
for (const [source,names] of [
 ['web/src/assets/img/structures',['mindMap.jpg','timeline.jpg','fishbone.jpg']],
 ['web/node_modules/simple-mind-map-plugin-themes/src/imgs',['classic15.png','classic12.png','classic11.png','classic6.jpg']]
]) for (const name of names) await cp(path.join(root,source,name),path.join(root,'cloud/editor/img',name));
console.log('Cloud editor built without changing upstream dist');
