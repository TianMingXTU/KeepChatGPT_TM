const fs = require('fs');
const path = require('path');

// 读取脚本源码，去掉 ==UserScript== 头部后执行
const scriptPath = path.resolve(__dirname, '../KeepChatGPT.user.js');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

// 提取 UserScript 头部之后的代码
const codeStart = scriptSource.indexOf('// ==/UserScript==');
const executableCode = scriptSource.slice(codeStart + '// ==/UserScript=='.length);

// 在 IIFE 执行前，向 global 注入探针，让内部函数可以被测试
// 脚本内部 var global = {} 会被挂到这里
let scriptGlobals = {};
global.__kcg_test_probe__ = scriptGlobals;

// 执行脚本（会触发 IIFE）
// 用 try/catch 捕获 DOM 依赖导致的错误，不影响单元测试
try {
  // eslint-disable-next-line no-new-func
  new Function('__kcg_test_probe__', executableCode)(scriptGlobals);
} catch (e) {
  // IIFE 中依赖 DOM/网络的部分会抛错，忽略，只测纯函数
}

const isTrackingRequest = scriptGlobals.__test__?.isTrackingRequest;
const extractConversationPreview = scriptGlobals.__test__?.extractConversationPreview;
const buildConversationRecordFromPayload = scriptGlobals.__test__?.buildConversationRecordFromPayload;
const shouldDeleteEverChangingRecord = scriptGlobals.__test__?.shouldDeleteEverChangingRecord;
const parseJsonSafely = scriptGlobals.__test__?.parseJsonSafely;
const sanitizeDataSecText = scriptGlobals.__test__?.sanitizeDataSecText;

// ─── 正则测试 ─────────────────────────────────────────────

describe('trackingBlockRegex', () => {
  test('测试辅助函数已暴露', () => {
    expect(typeof isTrackingRequest).toBe('function');
  });

  test('拦截 sentry.io 请求', () => {
    expect(isTrackingRequest('https://browser-intake-datadoghq.com/api/v2/rum')).toBe(true);
    expect(isTrackingRequest('https://sentry.io/api/1234/')).toBe(true);
  });

  test('拦截 intercom 请求', () => {
    expect(isTrackingRequest('https://api.intercom.io/messenger/')).toBe(true);
    expect(isTrackingRequest('https://widget.intercomcdn.com/foo.js')).toBe(true);
  });

  test('拦截 statsig 请求', () => {
    expect(isTrackingRequest('https://statsigapi.net/v1/initialize')).toBe(true);
    expect(isTrackingRequest('https://statsigapi.net/rgstr')).toBe(true);
  });

  test('拦截 GA 与 CES 埋点请求', () => {
    expect(isTrackingRequest('https://www.google-analytics.com/g/collect?v=2')).toBe(true);
    expect(isTrackingRequest('https://chatgpt.com/ces/v1/t')).toBe(true);
    expect(isTrackingRequest('https://chatgpt.com/ces/v1/p')).toBe(true);
    expect(isTrackingRequest('/ces/v1/telemetry/intake?ddforward=1')).toBe(true);
    expect(isTrackingRequest('/ces/statsc/flush')).toBe(true);
    expect(isTrackingRequest('/backend-api/beacons/home?conversation_id=123')).toBe(true);
  });

  test('不拦截正常请求', () => {
    expect(isTrackingRequest('https://chat.openai.com/api/auth/session')).toBe(false);
    expect(isTrackingRequest('https://chatgpt.com/backend-api/conversation')).toBe(false);
    expect(isTrackingRequest('https://chatgpt.com/backend-api/sentinel/heartbeat')).toBe(false);
    expect(isTrackingRequest('https://cdn.jsdelivr.net/foo.js')).toBe(false);
  });
});

describe('everChanging helpers', () => {
  test('提取会话预览时兼容富结构 content', () => {
    expect(typeof extractConversationPreview).toBe('function');
    const preview = extractConversationPreview({
      content: {
        parts: [
          { text: '第一段' },
          '第二段',
          { content: { parts: ['第三段'] } },
        ],
      },
    });
    expect(preview).toBe('第一段 第二段 第三段');
  });

  test('会话详情缺少 conversation_id 时使用 URL 兜底构建记录', () => {
    expect(typeof buildConversationRecordFromPayload).toBe('function');
    const record = buildConversationRecordFromPayload({
      title: '医生能力评估方法',
      update_time: 1741500000,
      current_node: 'node-1',
      mapping: {
        'node-1': {
          message: {
            create_time: 1741500000,
            content: { parts: ['最后一条回复'] },
            metadata: { model_slug: 'gpt-4o' },
          },
        },
      },
    }, '69be62a8-6788-8399-a133-c63bd049f1dc');
    expect(record).toMatchObject({
      id: '69be62a8-6788-8399-a133-c63bd049f1dc',
      title: '医生能力评估方法',
      last: '最后一条回复',
      model: 'gpt-4o',
    });
    expect(record.update_time instanceof Date).toBe(true);
  });

  test('归档或隐藏时删除 everChanging 缓存', () => {
    expect(typeof shouldDeleteEverChangingRecord).toBe('function');
    expect(shouldDeleteEverChangingRecord({ is_visible: false })).toBe(true);
    expect(shouldDeleteEverChangingRecord({ is_archived: true })).toBe(true);
    expect(shouldDeleteEverChangingRecord({ is_hidden: true })).toBe(true);
    expect(shouldDeleteEverChangingRecord({ is_visible: true })).toBe(false);
  });

  test('解析异常响应体时返回兜底对象', () => {
    expect(typeof parseJsonSafely).toBe('function');
    expect(parseJsonSafely('{"items":[{"id":"ok"}]}', { items: [] })).toEqual({
      items: [{ id: 'ok' }],
    });
    expect(parseJsonSafely('<html>not json</html>', { items: [] })).toEqual({
      items: [],
    });
  });
});

// ─── 数据安全默认规则测试 ──────────────────────────────────

describe('datasec_blocklist_default', () => {
  const defaultRules = "18888888888\nhttps://securiy-domain.com\n([\\w-]+(\\.[\\w-]+)*)@163\\.com\nmy-secret-username\n";
  const rules = defaultRules.trim().split('\n').map(r => new RegExp(r));

  test('匹配手机号', () => {
    expect(rules[0].test('18888888888')).toBe(true);
    expect(rules[0].test('13812345678')).toBe(false);
  });

  test('匹配163邮箱', () => {
    expect(rules[2].test('user@163.com')).toBe(true);
    expect(rules[2].test('user@gmail.com')).toBe(false);
  });

  test('匹配敏感用户名', () => {
    expect(rules[3].test('my-secret-username')).toBe(true);
    expect(rules[3].test('other-username')).toBe(false);
  });

  test('按规则清理敏感文本并返回命中项', () => {
    expect(typeof sanitizeDataSecText).toBe('function');
    const result = sanitizeDataSecText(
      '手机号 18888888888 邮箱 user@163.com 保留',
      defaultRules,
    );
    expect(result.text).toBe('手机号  邮箱  保留');
    expect(result.matches).toEqual(['18888888888', 'user@163.com']);
  });
});

// ─── GM mock 测试 ──────────────────────────────────────────

describe('GM_setValue / GM_getValue mock', () => {
  test('存取值正常工作', () => {
    GM_setValue('k_test', 'hello');
    expect(GM_getValue('k_test', '')).toBe('hello');
  });

  test('不存在的 key 返回默认值', () => {
    expect(GM_getValue('k_nonexistent', 'default')).toBe('default');
  });
});

describe('current page landmarks and ad isolation', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  test('finds the hashed-class sidebar without nav.flex', () => {
    document.body.innerHTML = '<aside><nav class="xrvj5dj"><a href="/">New chat</a></nav></aside>';
    expect(scriptGlobals.__test__.getKcgHost()).toBe(document.querySelector('nav'));
  });
  test('provides a floating host when the sidebar is collapsed', () => {
    document.body.innerHTML = '<textarea id="mobile-composer-prompt" name="prompt"></textarea>';
    expect(scriptGlobals.__test__.getKcgHost()).toBe(document.body);
    expect(document.querySelector(scriptGlobals.__test__.composer_selector).tagName).toBe('TEXTAREA');
  });
  test('does not bootstrap on unrelated pages', () => {
    document.body.innerHTML = '<nav>Unrelated navigation</nav>';
    expect(scriptGlobals.__test__.getKcgHost()).toBeNull();
  });
  test('retains the legacy rich-text composer', () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>';
    expect(document.querySelector(scriptGlobals.__test__.composer_selector)).not.toBeNull();
  });
  test('ad rules leave messages, code, sources and subscription UI alone', () => {
    document.body.innerHTML = '<article data-message-author-role="assistant"><p>Sponsored ads explained</p><code>data-ad-slot</code><a href="https://example.com/ad">Source</a></article><button data-testid="upgrade-button">Upgrade</button><div data-testid="ad-container">Ad</div><div data-ad-slot="1">Ad</div>';
    expect(document.querySelectorAll(scriptGlobals.__test__.ad_selector)).toHaveLength(2);
    expect(document.querySelector('article').matches(scriptGlobals.__test__.ad_selector)).toBe(false);
    expect(scriptGlobals.__test__.adStyleText).toContain('body.kpurifypage');
  });
});

describe('first-party download promotions', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  test('marks a desktop banner and a Codex install prompt, preserving ordinary content', () => {
    document.body.innerHTML = `<div data-testid="download-banner"><p>在桌面上使用 ChatGPT</p><a href="https://chatgpt.com/download">下载</a></div>
      <div role="dialog"><button>下载 Codex 应用</button></div>
      <nav><a href="https://chatgpt.com/codex">Codex</a></nav><ol data-conversation-transcript><li><a href="https://chatgpt.com/download">下载</a></li></ol>
      <article><a href="https://chatgpt.com/download">下载 ChatGPT</a><button>下载 Codex</button></article>
      <a href="https://example.org/download">下载 ChatGPT</a>
      <div data-testid="desktop-app-shell"><textarea></textarea></div>`;
    scriptGlobals.__test__.hideDownloadPromotions();
    expect(document.querySelector('[data-testid="download-banner"]').hasAttribute('data-kcg-promotion')).toBe(true);
    expect(document.querySelector('[role="dialog"]').hasAttribute('data-kcg-promotion')).toBe(true);
    expect(document.querySelectorAll('[data-kcg-promotion]')).toHaveLength(2);
  });
  test('does not hide a layout or conversation ancestor', () => {
    document.body.innerHTML = '<main data-testid="promo-shell"><textarea></textarea><a href="https://chatgpt.com/download">下载 ChatGPT</a></main>';
    scriptGlobals.__test__.hideDownloadPromotions();
    expect(document.querySelector('main').hasAttribute('data-kcg-promotion')).toBe(false);
    expect(document.querySelector('a').hasAttribute('data-kcg-promotion')).toBe(true);
  });
  test('handles later insertions and reused nodes', () => {
    document.body.innerHTML = '<button>安装 Codex 应用</button>';
    scriptGlobals.__test__.hideDownloadPromotions();
    const button = document.querySelector('button');
    expect(button.hasAttribute('data-kcg-promotion')).toBe(true);
    button.textContent = 'Settings';
    scriptGlobals.__test__.hideDownloadPromotions();
    expect(button.hasAttribute('data-kcg-promotion')).toBe(false);
  });
});

describe('Pro model upsell popup', () => {
  const copy = '<h2>GPT-6 Astra 专为这类任务而打造</h2><p>升级至 Pro，获得更多 Astra 使用额度，体验更强的判断力、更深入的上下文理解和更精良的成果。</p>';
  afterEach(() => { document.body.innerHTML = ''; });
  test('marks the supplied popup and preserves the surrounding app', () => {
    document.body.innerHTML = `<main><textarea></textarea></main><div role="dialog">${copy}<button>升级至 Pro</button></div>`;
    scriptGlobals.__test__.hideDownloadPromotions();
    expect(document.querySelector('[role="dialog"]').getAttribute('data-kcg-promotion')).toBe('upsell');
    expect(document.querySelector('main').hasAttribute('data-kcg-promotion')).toBe(false);
  });
  test('recognizes an unlabeled card without hiding the page layout', () => {
    document.body.innerHTML = `<main><div class="card">${copy}</div><textarea></textarea></main>`;
    scriptGlobals.__test__.hideDownloadPromotions();
    expect(document.querySelector('.card').getAttribute('data-kcg-promotion')).toBe('upsell');
    expect(document.querySelector('main').hasAttribute('data-kcg-promotion')).toBe(false);
  });
  test('keeps identical quoted text and ordinary account dialogs', () => {
    document.body.innerHTML = `<article>${copy}</article><ol data-conversation-transcript><li>${copy}</li></ol><div role="dialog"><h2>订阅管理</h2><button>升级至 Pro</button></div>`;
    scriptGlobals.__test__.hideDownloadPromotions();
    expect(document.querySelector('[data-kcg-promotion]')).toBeNull();
  });
  test('dismisses a recognized modal with its own close button', () => {
    document.body.innerHTML = `<div role="dialog">${copy}<button aria-label="关闭">×</button></div>`;
    const close = jest.fn();
    document.querySelector('button').addEventListener('click', close);
    scriptGlobals.__test__.hideDownloadPromotions();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('general upgrade campaigns', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  test.each([
    ['提升复杂代码的准确性', '升级你的套餐，使用前沿 Pro 推理模型调试复杂系统，并进行更深入的严密验证。'],
    ['提高研究效率', '升级至 Plus，解锁更多深度研究功能。'],
    ['更高的使用额度', '立即升级套餐，获得更多模型使用额度。'],
    ['Improve complex code accuracy', 'Upgrade your plan to use advanced Pro reasoning models for complex systems.'],
    ['Unlock more capabilities', 'Get ChatGPT Pro for more powerful models and higher usage limits.'],
  ])('recognizes changing campaign copy: %s', (title, description) => {
    document.body.innerHTML = `<div role="dialog"><h2>${title}</h2><p>${description}</p></div>`;
    scriptGlobals.__test__.hideDownloadPromotions();
    expect(document.querySelector('[role="dialog"]').getAttribute('data-kcg-promotion')).toBe('upsell');
  });
  test('recognizes an unlabelled coding campaign', () => {
    document.body.innerHTML = '<div class="card"><h3>提升复杂代码的准确性</h3><p>升级你的套餐，使用前沿 Pro 推理模型调试复杂系统，并进行更深入的严密验证。</p></div>';
    scriptGlobals.__test__.hideDownloadPromotions();
    expect(document.querySelector('.card').getAttribute('data-kcg-promotion')).toBe('upsell');
  });
  test.each([
    '<h2>管理订阅</h2><p>升级至 Pro 获取更多模型使用额度</p><button>取消订阅</button>',
    '<h2>已达到使用上限</h2><p>升级至 Pro 获取更多使用额度</p>',
    '<h2>更新可用</h2><p>请升级浏览器以使用此功能</p>',
    '<h2>升级至 Pro</h2><p>确认付款信息</p><input name="card">',
  ])('preserves functional dialogs: %s', content => {
    document.body.innerHTML = `<div role="dialog">${content}</div>`;
    scriptGlobals.__test__.hideDownloadPromotions();
    expect(document.querySelector('[data-kcg-promotion]')).toBeNull();
  });
});

describe('promotion dismissal and semantic markers', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  test('recognizes a marked upsell without fixed feature wording', () => {
    document.body.innerHTML = '<div data-testid="model-upsell"><h2>体验新能力</h2><button>升级至 Pro</button></div>';
    scriptGlobals.__test__.hideDownloadPromotions();
    expect(document.querySelector('[data-testid]').getAttribute('data-kcg-promotion')).toBe('upsell');
  });
  test('dismisses download promotions without touching the install action', () => {
    document.body.innerHTML = '<div role="dialog"><button>下载 Codex 应用</button><button>Not now</button></div>';
    const buttons = document.querySelectorAll('button');
    const install = jest.fn(), dismiss = jest.fn();
    buttons[0].onclick = install;
    buttons[1].onclick = dismiss;
    scriptGlobals.__test__.hideDownloadPromotions();
    scriptGlobals.__test__.hideDownloadPromotions();
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
  });
});
