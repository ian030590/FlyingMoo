const install = document.getElementById('btn-install');
const status = document.getElementById('pwa-status');
const isDesktop = Boolean(window.__TAURI__);
let prompt;

if (!isDesktop) {
  const fullscreen = document.getElementById('btn-fullscreen');
  if (document.fullscreenEnabled) fullscreen.classList.remove('hidden');
  fullscreen.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { status.textContent = '無法進入全螢幕，請檢查瀏覽器權限後重試。'; }
  });
  document.addEventListener('fullscreenchange', () => {
    fullscreen.textContent = document.fullscreenElement ? '離開全螢幕' : '全螢幕（Tobii 注視判定）';
  });
  status.classList.remove('hidden');
  status.textContent = '首次使用需連線下載離線模型；完成後可離線練習。';
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    prompt = event;
    install.classList.remove('hidden');
  });
  install.addEventListener('click', async () => {
    if (!prompt) return;
    await prompt.prompt();
    await prompt.userChoice;
    prompt = null;
    install.classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => install.classList.add('hidden'));
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', async () => {
      try {
        const registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
        const updateStatus = () => {
          if (registration.waiting) status.textContent = '新版已下載；結束練習並關閉所有遊戲視窗後，再開啟即可更新。';
          else if (registration.active) status.textContent = '離線資源已備妥，可安裝至主畫面。iPhone／iPad 請在分享選單選「加入主畫面」。';
        };
        updateStatus();
        registration.addEventListener('updatefound', () => {
          registration.installing?.addEventListener('statechange', updateStatus);
        });
        navigator.serviceWorker.addEventListener('controllerchange', updateStatus);
      } catch {
        status.textContent = '離線資源尚未備妥，請保持連線並重新開啟網頁。';
      }
    });
  } else status.textContent = '此瀏覽器無法啟用離線模式，請透過 HTTPS 使用支援 PWA 的瀏覽器。';
}
