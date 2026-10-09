/* Same-origin adapter: the workbench owns authentication, saves and document navigation. */
window.externalPublicPath = '/mindmap/editor/';
window.takeOverApp = true;
window.addEventListener('load', async () => {
 try {
  if (window.parent === window || !window.parent.KononMindmapEditorBridge) throw new Error('请从狐音导图工作台打开文件');
  const bridge = window.parent.KononMindmapEditorBridge;
  const initial = await bridge.load();
  const syncPalette = () => {
   const styles = window.parent.getComputedStyle(window.parent.document.documentElement);
   for (let i = 0; i < styles.length; i++) {
    const name = styles[i];
    if (name.startsWith('--km-')) document.documentElement.style.setProperty(name, styles.getPropertyValue(name));
   }
  };
  syncPalette();
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
  window.kononSetTheme = theme => {
   syncPalette();
   const isDark = theme === 'dark';
   if (window.kononCloudStore.state.localConfig.isDark !== isDark) {
    window.kononCloudStore.commit('setLocalConfig', {isDark});
   }
  };
  window.kononCloudStore.subscribe((mutation, state) => {
   if (mutation.type !== 'setLocalConfig' || typeof mutation.payload?.isDark !== 'boolean') return;
   const theme = state.localConfig.isDark ? 'dark' : 'light';
   if (window.parent.document.documentElement.dataset.theme !== theme && bridge.setTheme) bridge.setTheme(theme);
   syncPalette();
  });
  window.initApp();
 } catch (error) {
  const p=document.createElement('p');p.textContent=error.message;p.className='cloud-error';document.body.replaceChildren(p);
 }
});
