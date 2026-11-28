const browserApi = globalThis.browser ?? globalThis.chrome;

browserApi.action.onClicked.addListener(() => {
  browserApi.tabs.create({ url: browserApi.runtime.getURL('save.html') });
});
