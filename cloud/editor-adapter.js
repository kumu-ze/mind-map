/* Same-origin adapter: the workbench owns authentication, saves and document navigation. */
window.externalPublicPath = '/mindmap/editor/';
window.takeOverApp = true;
window.addEventListener('load', async () => {
 try {
  if (window.parent === window || !window.parent.KononMindmapEditorBridge) throw new Error('请从狐音导图工作台打开文件');
  const bridge = window.parent.KononMindmapEditorBridge;
  const initial = await bridge.load();
  let data = structuredClone(initial.data);
  const readonly = Boolean(initial.readonly);
  document.documentElement.dataset.cloudReadonly = String(readonly);
  window.kononCloudReadonly = readonly;
  window.takeOverAppMethods = {
   getMindMapData: () => data,
   saveMindMapData: value => { data = structuredClone(value); if (!readonly) Promise.resolve(bridge.save(data)).catch(() => {}); },
   getMindMapConfig: () => ({ readonly, enableFreeDrag:false }),
   saveMindMapConfig: () => {},
   getLanguage: () => 'zh',
   saveLanguage: () => {},
   getLocalConfig: () => ({ enableAi:false,isDark:initial.theme==='dark',isZenMode:readonly,openNodeRichText:true }),
   saveLocalConfig: () => {}
  };
  window.$bus.$on('app_inited', mindMap => {
   if (readonly) { mindMap.setMode('readonly'); }
   bridge.ready(mindMap,window);
  });
  window.kononSetTheme = theme => window.kononCloudStore.commit('setLocalConfig', {isDark:theme === 'dark'});
  window.initApp();
 } catch (error) {
  const p=document.createElement('p');p.textContent=error.message;p.className='cloud-error';document.body.replaceChildren(p);
 }
});
