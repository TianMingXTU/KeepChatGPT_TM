const fs = require('fs');
const source = fs.readFileSync(require.resolve('../KeepChatGPT.user.js'), 'utf8');

describe('current page runtime', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '<aside><nav class="xrvj5dj"><a href="/">New chat</a></nav></aside><textarea id="mobile-composer-prompt" name="prompt"></textarea>';
    global.indexedDB = { open: jest.fn(() => ({})) };
    global.fetch = jest.fn();
    GM_addStyle.mockImplementation(text => {
      const style = document.createElement('style');
      style.textContent = text;
      // jsdom's CSS parser lacks the existing stylesheet's native nesting support.
      // Keep this test focused on startup and menu events. 
      return style;
    });
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    document.body.innerHTML = '';
  });
  test.each([false, true])('mounts the entry and opens the menu (collapsed=%s)', async collapsed => {
    if (collapsed) document.querySelector('aside').remove();
    new Function(source)();
    window.dispatchEvent(new Event('load'));
    await jest.advanceTimersByTimeAsync(800);
    const entry = document.querySelector('#kcg');
    expect(entry).not.toBeNull();
    entry.click();
    expect(document.querySelector('.kmenu').classList.contains('kshow')).toBe(true);
    document.querySelector('#nmenuid_pp').click();
    expect(document.body.classList.contains('kpurifypage')).toBe(true);
    const popup = document.createElement('div');
    popup.setAttribute('role', 'dialog');
    popup.innerHTML = '<h2>GPT-6 Astra 专为这类任务而打造</h2><p>升级至 Pro，获得更多 Astra 使用额度，体验更深入的上下文理解。</p>';
    document.body.appendChild(popup);
    await jest.advanceTimersByTimeAsync(1100);
    expect(popup.getAttribute('data-kcg-promotion')).toBe('upsell');
    document.querySelector('#nmenuid_pp').click();
    expect(document.body.classList.contains('kpurifypage')).toBe(false);
  });
});
