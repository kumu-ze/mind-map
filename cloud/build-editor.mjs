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
console.log('Cloud editor built without changing upstream dist');
