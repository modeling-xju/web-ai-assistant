/*!
 * web-ai-assistant · 网站内嵌 AI 助手挂件
 * 零依赖 · Shadow DOM 样式隔离 · SSE 流式 · 后端 adapter 可替换
 *
 * 用法见 assets/embed-selfhosted.html 与 references/self-hosted-widget.md
 */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';

  /* ────────────────────────────────────────────────────────────
   * 工具
   * ──────────────────────────────────────────────────────────── */

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * 极简 Markdown → HTML。
   * 先抽出代码块占位，再转义剩余文本，最后只对白名单语法做替换。
   * 顺序很关键：先转义再替换，否则用户/AI 输出里的 <img onerror> 能直接执行。
   */
  function renderMarkdown(src) {
    var blocks = [];
    var text = String(src == null ? '' : src);

    // 1. 抽出围栏代码块
    text = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      blocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
      return '\u0000BLOCK' + (blocks.length - 1) + '\u0000';
    });

    // 2. 转义
    text = escapeHtml(text);

    // 3. 行内代码
    text = text.replace(/`([^`\n]+)`/g, function (_, c) {
      return '<code class="waa-code-inline">' + c + '</code>';
    });

    // 4. 链接：[文字](url) 与裸链接
    text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

    // 5. 粗体 / 斜体
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

    // 6. 按行组装段落与列表
    var out = [];
    var list = null; // 'ul' | 'ol'
    function closeList() { if (list) { out.push('</' + list + '>'); list = null; } }

    text.split('\n').forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      var blockRef = /^\u0000BLOCK(\d+)\u0000$/.exec(line.replace(/^\s+|\s+$/g, ''));
      if (blockRef) {
        closeList();
        var b = blocks[Number(blockRef[1])];
        out.push(
          '<div class="waa-code"><div class="waa-code__bar"><span class="waa-code__lang">' +
          escapeHtml(b.lang || 'code') +
          '</span><button type="button" class="waa-code__copy" data-copy="' +
          escapeHtml(b.code) + '">复制</button></div><pre><code>' +
          escapeHtml(b.code) + '</code></pre></div>'
        );
        return;
      }
      var ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      var ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + ul[1] + '</li>'); return; }
      if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + ol[1] + '</li>'); return; }
      closeList();
      if (line.trim() === '') return;
      out.push('<p>' + line + '</p>');
    });
    closeList();
    return out.join('');
  }

  /* ────────────────────────────────────────────────────────────
   * SSE 读取：把 fetch 的响应体拆成一条条 data 负载
   * ──────────────────────────────────────────────────────────── */

  async function* readSSE(res) {
    if (!res.body || !res.body.getReader) return;
    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    function* drain(final) {
      buf = buf.replace(/\r\n/g, '\n');
      var idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        var chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        var lines = chunk.split('\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.indexOf('data:') === 0) yield line.slice(5).trim();
        }
      }
      if (final && buf.trim()) {
        var tail = buf.split('\n');
        for (var j = 0; j < tail.length; j++) {
          if (tail[j].indexOf('data:') === 0) yield tail[j].slice(5).trim();
        }
        buf = '';
      }
    }
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      buf += decoder.decode(r.value, { stream: true });
      yield* drain(false);
    }
    buf += decoder.decode();
    yield* drain(true);
  }

  /**
   * 上游报错时把响应体压成一句人话。
   * 很多网关失败时返回的是整页 HTML（Nginx/网关错误页），原样贴进对话框既没信息量又难看，
   * 所以这里剥标签、截断，并识别常见的纯 HTML 响应。
   */
  function briefBody(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    if (/^<!doctype|^<html/i.test(s)) {
      var m = /<title[^>]*>([^<]{2,80})<\/title>/i.exec(s);
      return m ? m[1] : '（上游返回了 HTML 错误页）';
    }
    s = s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return s.length > 140 ? s.slice(0, 140) + '…' : s;
  }

  function HttpError(status, body) {
    var brief = briefBody(body);
    var e = new Error('HTTP ' + status + (brief ? ' · ' + brief : ''));
    e.name = 'HttpError';
    e.status = status;
    e.raw = body;
    return e;
  }

  /* ────────────────────────────────────────────────────────────
   * 传输层（adapter）
   *
   * 契约——自定义实现必须满足，界面只依赖这个契约：
   *   async transport({ messages, config, signal, onDelta }) -> string(最终全文)
   *     messages: [{ role: 'user' | 'assistant', content: string }]
   *     onDelta(deltaText, fullText): 每收到一段就调一次
   *
   * 换模型供应商 = 换一个 transport，界面代码一行都不用动。
   * ──────────────────────────────────────────────────────────── */

  var transports = {};

  /** 本地假回复。不发任何网络请求，用于开发预览与自动化验收。 */
  transports.echo = async function (ctx) {
    var last = ctx.messages[ctx.messages.length - 1];
    var reply = ctx.config.echoReply ||
      ('（本地预览模式）我收到了你的消息：「' + String(last ? last.content : '') +
       '」。\n\n接入真实后端后，这里会显示模型的流式回复。\n\n- 当前 transport：`echo`\n- 换个 `data-transport` 即可对接真实模型');
    var text = '';
    for (var i = 0; i < reply.length; i += 2) {
      if (ctx.signal && ctx.signal.aborted) throw new DOMException('aborted', 'AbortError');
      var piece = reply.slice(i, i + 2);
      text += piece;
      ctx.onDelta(piece, text);
      await new Promise(function (r) { setTimeout(r, 12); });
    }
    return text;
  };

  /** OpenAI 兼容协议（含百炼 compatible-mode、vLLM、Ollama、各类网关）。 */
  transports.openai = async function (ctx) {
    var c = ctx.config;
    if (!c.endpoint) throw new Error('缺少 endpoint');
    var headers = { 'Content-Type': 'application/json' };
    if (c.apiKey) headers.Authorization = 'Bearer ' + c.apiKey;
    Object.assign(headers, c.headers || {});

    var res = await fetch(c.endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(Object.assign({
        model: c.model,
        messages: ctx.messages,
        stream: true
      }, c.body || {})),
      signal: ctx.signal
    });
    if (!res.ok) throw HttpError(res.status, await safeText(res));

    var ct = res.headers.get('content-type') || '';
    if (ct.indexOf('text/event-stream') === -1) {
      // 后端不支持流式：退化成一次性返回
      var json = await res.json().catch(function () { return null; });
      var whole = json && json.choices && json.choices[0] &&
        ((json.choices[0].message && json.choices[0].message.content) || json.choices[0].text) || '';
      if (whole && ctx.onDelta) ctx.onDelta(whole, whole);
      return whole;
    }

    var text = '';
    for await (var data of readSSE(res)) {
      if (data === '[DONE]') break;
      var chunk;
      try { chunk = JSON.parse(data); } catch (e) { continue; }
      if (chunk.error) throw new Error(chunk.error.message || '上游返回错误');
      var choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;
      var delta = (choice.delta && choice.delta.content) || '';
      if (delta) { text += delta; ctx.onDelta(delta, text); }
    }
    return text;
  };

  /** 阿里云百炼「智能体应用」直连（/api/v1/apps/{appId}/completion）。 */
  transports.dashscopeApp = async function (ctx) {
    var c = ctx.config;
    var appId = c.appId;
    if (!appId) throw new Error('缺少 appId（百炼应用 ID）');
    // 智能体应用接口只吃单一 prompt，把历史压平进去
    var prompt = ctx.messages.map(function (m) {
      return (m.role === 'user' ? '用户：' : '助手：') + m.content;
    }).join('\n').replace(/^助手：[\s\S]*?\n/, '') + '\n助手：';

    var res = await fetch(
      (c.endpoint || 'https://dashscope.aliyuncs.com') + '/api/v1/apps/' + encodeURIComponent(appId) + '/completion',
      {
        method: 'POST',
        headers: Object.assign({
          'Content-Type': 'application/json',
          'X-DashScope-SSE': 'enable',
          Authorization: 'Bearer ' + (c.apiKey || '')
        }, c.headers || {}),
        body: JSON.stringify({
          input: Object.assign({ prompt: prompt }, c.sessionId ? { session_id: c.sessionId } : {}),
          parameters: c.parameters || {},
          debug: {}
        }),
        signal: ctx.signal
      }
    );
    if (!res.ok) throw HttpError(res.status, await safeText(res));

    var text = '';
    for await (var data of readSSE(res)) {
      if (!data || data === '[DONE]') continue;
      var chunk;
      try { chunk = JSON.parse(data); } catch (e) { continue; }
      if (chunk.code) throw new Error(chunk.message || chunk.code);
      // DashScope 的 SSE 里 output.text 是增量片段，直接累加
      var piece = chunk.output && chunk.output.text;
      if (piece) { text += piece; ctx.onDelta(piece, text); }
    }
    return text;
  };

  async function safeText(res) {
    try { return await res.text(); } catch (e) { return ''; }
  }

  /* ────────────────────────────────────────────────────────────
   * 默认文案与默认配置
   * ──────────────────────────────────────────────────────────── */

  var COPY = {
    zh: {
      open: '打开助手', close: '关闭', send: '发送', stop: '停止',
      input: '输入你的问题…', retry: '重试', thinking: '正在回答',
      online: '在线', offline: '连接中断', emptyHint: '这些是常见的问法',
      copied: '已复制', newChat: '新对话'
    },
    en: {
      open: 'Open assistant', close: 'Close', send: 'Send', stop: 'Stop',
      input: 'Ask a question…', retry: 'Retry', thinking: 'Answering',
      online: 'Online', offline: 'Disconnected', emptyHint: 'Frequently asked',
      copied: 'Copied', newChat: 'New chat'
    }
  };

  var DEFAULTS = {
    name: '助手',
    locale: 'zh',
    transport: 'openai',
    endpoint: '',
    model: '',
    apiKey: '',
    appId: '',
    headers: null,
    body: null,
    greeting: '',
    suggestions: [],
    theme: 'auto',            // auto | light | dark
    position: 'right',        // right | left
    draggable: true,
    autoOpen: false,
    persist: true,            // sessionStorage 里保留本次会话
    sessionKey: 'waa:session',
    zIndex: 2147483000,
    accent: '',
    radius: '',
    css: '',                  // 传入自定义 CSS 字符串时覆盖默认样式表
    cssUrl: '',               // 或指定自定义样式表地址
    extraInfo: null,          // 对象，或 () => 对象，随请求发送
    onBeforeSend: null,       // (ctx) => false 可取消发送
    onAfterSend: null,        // (ctx) => void
    onError: null,
    echoReply: ''
  };

  /* ────────────────────────────────────────────────────────────
   * 挂件本体
   * ──────────────────────────────────────────────────────────── */

  var idSeq = 0;

  function Widget(options) {
    this.opts = Object.assign({}, DEFAULTS, options || {});
    this.scriptEl = this.opts.scriptEl || null;
    this.copy = COPY[this.opts.locale] || COPY.zh;
    this.messages = [];
    this.busy = false;
    this.abort = null;
    this.id = 'waa-' + (++idSeq);
    this.built = false;
    this.openState = false;
    this._build();
  }

  Widget.prototype._build = function () {
    var self = this;
    var host = document.createElement('div');
    host.id = this.id;
    host.setAttribute('data-waa-host', '');
    host.style.cssText = 'all:initial;position:fixed;z-index:' + this.opts.zIndex + ';' +
      (this.opts.position === 'left' ? 'left:0;' : 'right:0;') + 'bottom:0;' +
      'width:0;height:0;pointer-events:none;';
    this.host = host;

    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    this.root = root;

    // 样式容器：自定义 CSS 直接写入，否则等样式表加载完再填（避免未样式化的闪烁）
    this.localStyle = h('style', { text: this.opts.css || '' });
    root.appendChild(this.localStyle);

    // 主题变量
    var vars = [];
    if (this.opts.accent) vars.push('--waa-accent:' + this.opts.accent);
    if (this.opts.radius) vars.push('--waa-radius:' + this.opts.radius);
    this.root.appendChild(h('div', {
      class: 'waa',
      'data-theme': this.opts.theme,
      'data-position': this.opts.position,
      style: vars.join(';')
    }));

    this.el = root.querySelector('.waa');

    // 启动器
    this.launcher = h('button', {
      type: 'button', class: 'waa-launcher',
      'aria-label': this.copy.open, 'aria-expanded': 'false',
      onclick: function () { self.toggle(); }
    }, [
      h('span', { class: 'waa-launcher__glyph', 'aria-hidden': 'true' }, [this._glyph()]),
      h('span', { class: 'waa-launcher__badge', hidden: true })
    ]);

    // 面板
    this.log = h('div', {
      class: 'waa-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions text'
    });

    this.input = h('textarea', {
      class: 'waa-input', rows: '1', 'aria-label': this.copy.input,
      placeholder: this.copy.input
    });
    this.input.addEventListener('input', function () { self._autosize(); });
    this.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        self._submit();
      }
    });

    this.sendBtn = h('button', {
      type: 'button', class: 'waa-send', 'aria-label': this.copy.send,
      onclick: function () { self._submit(); }
    }, [h('span', { 'aria-hidden': 'true', text: '↑' })]);

    this.headMeta = h('span', { class: 'waa-head__meta', text: this.copy.online });

    this.panel = h('section', {
      class: 'waa-panel', role: 'dialog', 'aria-modal': 'false',
      'aria-label': this.opts.name, hidden: true
    }, [
      h('header', { class: 'waa-head' }, [
        h('span', { class: 'waa-head__pulse', 'aria-hidden': 'true' }),
        h('h2', { class: 'waa-head__name', text: this.opts.name }),
        this.headMeta,
        h('button', {
          type: 'button', class: 'waa-iconbtn waa-head__new',
          'aria-label': this.copy.newChat, title: this.copy.newChat,
          onclick: function () { self.reset(); }
        }, [h('span', { 'aria-hidden': 'true', text: '↺' })]),
        h('button', {
          type: 'button', class: 'waa-iconbtn waa-head__close',
          'aria-label': this.copy.close,
          onclick: function () { self.close(); }
        }, [h('span', { 'aria-hidden': 'true', text: '×' })])
      ]),
      this.log,
      h('form', { class: 'waa-compose', onsubmit: function (e) { e.preventDefault(); self._submit(); } }, [
        this.input,
        this.sendBtn
      ])
    ]);

    this.el.appendChild(this.launcher);
    this.el.appendChild(this.panel);

    this._bindGlobal();
    this._renderEmpty();
    this._loadSession();

    var attach = function () { (document.body || document.documentElement).appendChild(host); };
    if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach);
    this.built = true;

    this._injectStylesheet();

    if (this.opts.draggable) this._makeDraggable();
    if (this.opts.autoOpen) this.open();

    var mq = global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)');
    if (mq && this.opts.theme === 'auto') {
      var onScheme = function () { self._syncTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', onScheme);
      else if (mq.addListener) mq.addListener(onScheme);
    }
    this._syncTheme();
  };

  Widget.prototype._glyph = function () {
    // 一个有缺角的方块 + 内部短横，避免和市面上千篇一律的聊天气泡撞脸
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    svg.setAttribute('fill', 'none');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4 5h11l5 5v9H4z');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linejoin', 'round');
    var l1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    l1.setAttribute('d', 'M7.5 10.5h6M7.5 14h4');
    l1.setAttribute('stroke', 'currentColor');
    l1.setAttribute('stroke-width', '1.6');
    l1.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
    svg.appendChild(l1);
    return svg;
  };

  Widget.prototype._injectStylesheet = function () {
    var self = this;
    if (this.opts.css) return;
    var url = this.opts.cssUrl || this._guessCssUrl();
    if (!url) {
      // 打包后的 SPA 里 script.src 是带哈希的 bundle 名，猜不到同名 css。
      // 静默降级会让人以为"挂件坏了"，所以这里必须出声。
      if (global.console && console.warn) {
        console.warn('[web-ai-assistant] 没能自动定位样式表，挂件会以无样式状态渲染。' +
          '请显式传入 cssUrl（例如 Vite: `import cssUrl from "./ai-assistant.css?url"`）或 css 字符串。');
      }
      return;
    }
    // 优先 fetch 成 <style>：同步生效，不会有未样式化的闪烁
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error('css ' + r.status);
      return r.text();
    }).then(function (css) {
      if (self.localStyle) self.localStyle.textContent = css;
      else self.root.appendChild(h('style', { text: css }));
    }).catch(function () {
      // file:// 或跨域下 fetch 会被拦，退化成 <link>
      self.root.appendChild(h('link', { rel: 'stylesheet', href: url }));
    });
  };

  Widget.prototype._guessCssUrl = function () {
    if (this.opts.cssUrl) return this.opts.cssUrl;
    // document.currentScript 只有在"直接处于某个 <script> 执行中"才有值。
    // 常见两种失灵：mount() 从内联脚本里调用（currentScript 是内联脚本、没有 src），
    // 或从 load 回调里调用（currentScript 为 null）。两种都要退回去按文件名找。
    var s = document.currentScript;
    if (!s || !s.src) {
      var all = document.querySelectorAll('script[src*="ai-assistant"]');
      s = all[all.length - 1] || s;
    }
    if (!s && this.scriptEl) s = this.scriptEl;
    if (s && s.src) return s.src.replace(/\.js(\?|#|$)/, '.css$1');
    return '';
  };

  Widget.prototype._bindGlobal = function () {
    var self = this;
    this._onKey = function (e) {
      if (e.key === 'Escape' && self.openState) self.close();
    };
    document.addEventListener('keydown', this._onKey);
  };

  Widget.prototype._syncTheme = function () {
    var t = this.opts.theme;
    if (t === 'auto') {
      t = (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    this.el.setAttribute('data-theme', t);
  };

  Widget.prototype._autosize = function () {
    this.input.style.height = 'auto';
    this.input.style.height = Math.min(this.input.scrollHeight, 132) + 'px';
  };

  Widget.prototype._makeDraggable = function () {
    var self = this;
    var storeKey = 'waa:pos';
    try {
      var saved = JSON.parse(localStorage.getItem(storeKey) || 'null');
      if (saved) this._applyPos(saved);
    } catch (e) { /* 忽略 */ }

    var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    this.launcher.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      var r = self.launcher.getBoundingClientRect();
      ox = r.left; oy = r.top;
      self.launcher.setPointerCapture(e.pointerId);
    });
    this.launcher.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return; // 抖动阈值：小于 4px 仍视为点击
      moved = true;
      self.launcher.classList.add('is-dragging');
      self._applyPos({ x: ox + dx, y: oy + dy });
    });
    this.launcher.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      dragging = false;
      self.launcher.classList.remove('is-dragging');
      try { self.launcher.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      if (moved) {
        var r = self.launcher.getBoundingClientRect();
        try { localStorage.setItem(storeKey, JSON.stringify({ x: r.left, y: r.top })); } catch (err) { /* 忽略 */ }
        // 拖动结束后抑制掉这次 click，否则会顺手把面板打开
        var stop = function (ev) { ev.stopPropagation(); ev.preventDefault(); self.launcher.removeEventListener('click', stop, true); };
        self.launcher.addEventListener('click', stop, true);
      }
    });
  };

  Widget.prototype._applyPos = function (p) {
    var w = this.launcher.offsetWidth || 52, hh = this.launcher.offsetHeight || 52;
    var x = Math.max(8, Math.min(p.x, global.innerWidth - w - 8));
    var y = Math.max(8, Math.min(p.y, global.innerHeight - hh - 8));
    this.launcher.style.position = 'fixed';
    this.launcher.style.left = x + 'px';
    this.launcher.style.top = y + 'px';
    this.launcher.style.right = 'auto';
    this.launcher.style.bottom = 'auto';
    this.el.setAttribute('data-floating', '');
  };

  /* ── 消息渲染 ───────────────────────────────────────────── */

  Widget.prototype._renderEmpty = function () {
    var self = this;
    this.log.textContent = '';
    var box = h('div', { class: 'waa-empty' });
    if (this.opts.greeting) {
      box.appendChild(h('p', { class: 'waa-empty__greeting', text: this.opts.greeting }));
    }
    var sug = this.opts.suggestions || [];
    if (sug.length) {
      var wrap = h('div', { class: 'waa-suggest' });
      sug.slice(0, 4).forEach(function (s) {
        wrap.appendChild(h('button', {
          type: 'button', class: 'waa-suggest__item', text: s,
          onclick: function () { self.send(s); }
        }));
      });
      box.appendChild(wrap);
    }
    this.log.appendChild(box);
  };

  Widget.prototype._append = function (role, content) {
    var empty = this.log.querySelector('.waa-empty');
    if (empty) empty.remove();
    var node = h('div', { class: 'waa-msg waa-msg--' + role });
    if (role === 'assistant') node.appendChild(h('div', { class: 'waa-msg__rule' }));
    var body = h('div', { class: 'waa-msg__body' });
    if (role === 'assistant') body.innerHTML = renderMarkdown(content || '');
    else body.textContent = content || '';
    node.appendChild(body);
    this.log.appendChild(node);
    this._scroll();
    return { node: node, body: body };
  };

  Widget.prototype._appendError = function (message) {
    var self = this;
    var node = h('div', { class: 'waa-msg waa-msg--error' }, [
      h('div', { class: 'waa-msg__rule' }),
      h('div', { class: 'waa-msg__body' }, [
        h('p', { class: 'waa-error__text', text: message }),
        h('button', {
          type: 'button', class: 'waa-retry', text: this.copy.retry,
          onclick: function () { node.remove(); self._resend(); }
        })
      ])
    ]);
    this.log.appendChild(node);
    this._scroll();
  };

  Widget.prototype._scroll = function () {
    var el = this.log;
    requestAnimationFrame(function () { el.scrollTop = el.scrollHeight; });
  };

  Widget.prototype._setHeadMeta = function (text, kind) {
    this.headMeta.textContent = text;
    if (kind) this.headMeta.setAttribute('data-kind', kind);
    else this.headMeta.removeAttribute('data-kind');
  };

  /* ── 会话 ───────────────────────────────────────────────── */

  Widget.prototype._sessionKey = function () { return this.opts.sessionKey; };

  Widget.prototype._saveSession = function () {
    if (!this.opts.persist) return;
    try { sessionStorage.setItem(this._sessionKey(), JSON.stringify(this.messages.slice(-40))); }
    catch (e) { /* 隐私模式会抛错，忽略 */ }
  };

  Widget.prototype._loadSession = function () {
    if (!this.opts.persist) return;
    var raw;
    try { raw = sessionStorage.getItem(this._sessionKey()); } catch (e) { return; }
    if (!raw) return;
    var msgs;
    try { msgs = JSON.parse(raw); } catch (e) { return; }
    if (!Array.isArray(msgs) || !msgs.length) return;
    this.messages = msgs;
    var self = this;
    var empty = this.log.querySelector('.waa-empty');
    if (empty) empty.remove();
    msgs.forEach(function (m) { self._append(m.role, m.content); });
  };

  Widget.prototype.reset = function () {
    this.messages = [];
    try { sessionStorage.removeItem(this._sessionKey()); } catch (e) { /* 忽略 */ }
    this._renderEmpty();
    this._setHeadMeta(this.copy.online);
    this.input.focus();
  };

  /* ── 发送 ───────────────────────────────────────────────── */

  Widget.prototype._resolveTransport = function () {
    var t = this.opts.transport;
    if (typeof t === 'function') return t;
    if (typeof t === 'string' && transports[t]) return transports[t];
    throw new Error('未知的 transport：' + t);
  };

  Widget.prototype.send = function (text) {
    var v = String(text == null ? this.input.value : text).trim();
    if (!v || this.busy) return;
    this.input.value = '';
    this._autosize();
    this._append('user', v);
    this.messages.push({ role: 'user', content: v });
    this._saveSession();
    this._run();
  };

  Widget.prototype._submit = function () { this.send(); };

  Widget.prototype._resend = function () {
    if (this.busy) return;
    if (!this.messages.length || this.messages[this.messages.length - 1].role !== 'user') return;
    this._run();
  };

  Widget.prototype._run = async function () {
    var self = this;
    var ctx = {
      messages: this.messages.slice(),
      config: this.opts,
      signal: null,
      onDelta: null
    };

    if (typeof this.opts.onBeforeSend === 'function') {
      var proceed;
      try { proceed = await this.opts.onBeforeSend({ messages: ctx.messages, config: this.opts }); }
      catch (e) { proceed = true; }
      if (proceed === false) return;
    }

    this.busy = true;
    this.abort = new AbortController();
    ctx.signal = this.abort.signal;
    this._setHeadMeta(this.copy.thinking, 'busy');
    this.sendBtn.classList.add('is-stop');
    this.sendBtn.setAttribute('aria-label', this.copy.stop);

    var target = this._append('assistant', '');
    target.node.classList.add('is-streaming');
    var acc = '';
    var started = false;
    ctx.onDelta = function (_delta, full) {
      started = true;
      acc = full != null ? full : acc + _delta;
      target.body.innerHTML = renderMarkdown(acc);
      self._scroll();
    };

    try {
      var transport = this._resolveTransport();
      var finalText = await transport(ctx);
      if (finalText != null && finalText !== '' && !started) {
        acc = finalText;
        target.body.innerHTML = renderMarkdown(acc);
      }
      if (!acc) acc = finalText || '';
      target.node.classList.remove('is-streaming');
      this.messages.push({ role: 'assistant', content: acc });
      this._saveSession();
      this._setHeadMeta(this.copy.online);
      if (typeof this.opts.onAfterSend === 'function') {
        try { this.opts.onAfterSend({ messages: this.messages.slice(), reply: acc, config: this.opts }); }
        catch (e) { /* 埋点失败不能影响体验 */ }
      }
    } catch (err) {
      target.node.remove();
      if (err && err.name === 'AbortError') {
        if (acc) {
          this.messages.push({ role: 'assistant', content: acc });
          this._saveSession();
          var stopped = this._append('assistant', acc);
          stopped.node.classList.add('is-stopped');
        }
        this._setHeadMeta(this.copy.online);
      } else {
        var msg = err && err.message ? err.message : '请求失败';
        if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
          msg = this.opts.locale === 'en' ? 'Network unreachable. Check the endpoint.' : '连不上服务，检查接口地址或网络。';
        }
        this._appendError(msg);
        this._setHeadMeta(this.copy.offline, 'error');
        if (typeof this.opts.onError === 'function') { try { this.opts.onError(err); } catch (e) { /* 忽略 */ } }
      }
    } finally {
      this.busy = false;
      this.abort = null;
      this.sendBtn.classList.remove('is-stop');
      this.sendBtn.setAttribute('aria-label', this.copy.send);
    }
  };

  /* ── 开关 ───────────────────────────────────────────────── */

  Widget.prototype.open = function () {
    this.openState = true;
    this.panel.hidden = false;
    this.el.classList.add('is-open');
    this.launcher.setAttribute('aria-expanded', 'true');
    this.launcher.setAttribute('aria-label', this.copy.close);
    var badge = this.launcher.querySelector('.waa-launcher__badge');
    if (badge) badge.hidden = true;
    var self = this;
    requestAnimationFrame(function () {
      self.input.focus();
      self._scroll();
    });
  };

  Widget.prototype.close = function () {
    this.openState = false;
    this.panel.hidden = true;
    this.el.classList.remove('is-open');
    this.launcher.setAttribute('aria-expanded', 'false');
    this.launcher.setAttribute('aria-label', this.copy.open);
    if (this.busy && this.abort) this.abort.abort();
  };

  Widget.prototype.toggle = function () { this.openState ? this.close() : this.open(); };

  Widget.prototype.destroy = function () {
    document.removeEventListener('keydown', this._onKey);
    if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
  };

  /** 运行期更新业务上下文，下一次请求就会带上。 */
  Widget.prototype.setExtraInfo = function (info) {
    this._extraInfo = info;
  };

  /* ────────────────────────────────────────────────────────────
   * 对外接口
   * ──────────────────────────────────────────────────────────── */

  var instances = [];

  function mount(options) {
    var w = new Widget(options || {});
    instances.push(w);
    return w;
  }

  function defineTransport(name, fn) {
    transports[name] = fn;
  }

  function autoMount() {
    var scripts = document.querySelectorAll('script[data-waa]');
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      if (s.__waaMounted) continue;
      s.__waaMounted = true;
      var d = s.dataset;
      var w = mount({
        scriptEl: s,
        name: d.name || DEFAULTS.name,
        locale: d.locale || DEFAULTS.locale,
        transport: d.transport || DEFAULTS.transport,
        endpoint: d.endpoint || '',
        model: d.model || '',
        appId: d.appId || '',
        cssUrl: d.cssUrl || '',
        greeting: d.greeting || '',
        suggestions: d.suggestions ? d.suggestions.split('|').map(function (x) { return x.trim(); }).filter(Boolean) : [],
        theme: d.theme || DEFAULTS.theme,
        position: d.position || DEFAULTS.position,
        draggable: d.draggable !== 'false',
        autoOpen: d.autoOpen === 'true',
        accent: d.accent || '',
        radius: d.radius || '',
        zIndex: Number(d.zIndex) || DEFAULTS.zIndex,
        persist: d.persist !== 'false'
      });
      s.__waaInstance = w;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount);
  } else {
    setTimeout(autoMount, 0);
  }

  global.WebAIAssistant = {
    version: VERSION,
    mount: mount,
    defineTransport: defineTransport,
    transports: transports,
    instances: instances
  };
})(window);
