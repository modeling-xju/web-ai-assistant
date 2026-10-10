/*!
 * web-ai-assistant · 网站内嵌 AI 助手挂件
 * 零依赖 · Shadow DOM 样式隔离 · SSE 流式 · 后端 adapter 可替换
 *
 * 用法见 assets/embed-selfhosted.html 与 references/self-hosted-widget.md
 */
(function (global) {
  'use strict';

  var VERSION = '2.1.1';
  var SVG_NS = 'http://www.w3.org/2000/svg';

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
        else if (k === 'html') el.innerHTML = v;
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

  function icon(paths, size) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size || 15);
    s.setAttribute('height', size || 15);
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.7');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    paths.forEach(function (d) {
      var p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    });
    return s;
  }

  var ICONS = {
    plus: ['M12 5v14', 'M5 12h14'],
    list: ['M8 6h12', 'M8 12h12', 'M8 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    send: ['M12 19V5', 'M6 11l6-6 6 6'],
    trash: ['M4 7h15', 'M9.5 7V5h5v2', 'M6.5 7l.9 12.5h9.2L17.5 7'],
    // 用滑杆而不是齿轮：齿轮在 15px 下会糊成一个太阳，滑杆这个尺寸仍然认得出来
    sliders: ['M4 8h8', 'M17 8h3', 'M4 16h3', 'M12 16h8', 'M15 5v6', 'M9 13v6']
  };

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
  function renderMarkdown(src, L) {
    L = L || { copyBtn: '复制', copied: '已复制', copyFail: '复制失败' };
    var blocks = [];
    var text = String(src == null ? '' : src);

    text = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      blocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
      return '\u0000BLOCK' + (blocks.length - 1) + '\u0000';
    });

    text = escapeHtml(text);

    text = text.replace(/`([^`\n]+)`/g, function (_, c) {
      return '<code class="waa-code-inline">' + c + '</code>';
    });

    text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

    var out = [];
    var list = null;
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
          escapeHtml(b.code) + '" data-copied="' + escapeHtml(L.copied) +
          '" data-fail="' + escapeHtml(L.copyFail) + '">' + escapeHtml(L.copyBtn) +
          '</button></div><pre><code>' +
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
   * SSE
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
          if (lines[i].indexOf('data:') === 0) yield lines[i].slice(5).trim();
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

  async function safeText(res) {
    try { return await res.text(); } catch (e) { return ''; }
  }

  /* ────────────────────────────────────────────────────────────
   * 传输层（adapter）
   *
   * 契约——自定义实现必须满足，界面只依赖这个契约：
   *   async transport({ messages, config, signal, onDelta, onReferences, memory, knowledge })
   *     -> string | { text, references }
   *
   *   onDelta(deltaText, fullText)    每收到一段就调一次
   *   onReferences(list)              知识库命中的资料，界面会渲染成「参考资料」
   *     每项形如 { title, url?, snippet? }
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

  /** 按 auth 风格拼鉴权头。默认 bearer；Anthropic 用 x-api-key。 */
  function authHeaders(c) {
    var h = {};
    if (!c.apiKey) return h;
    var style = c.auth || 'bearer';
    if (style === 'x-api-key') h['x-api-key'] = c.apiKey;
    else if (style !== 'none') h.Authorization = 'Bearer ' + c.apiKey;
    return h;
  }

  /** OpenAI 兼容协议（含百炼 compatible-mode、vLLM、Ollama、各类网关）。 */
  transports.openai = async function (ctx) {
    var c = ctx.config;
    if (!c.endpoint) throw new Error('缺少 endpoint（或指定 provider 预设）');
    var headers = Object.assign({ 'Content-Type': 'application/json' }, authHeaders(c), c.headers || {});

    var body = Object.assign({
      model: c.model,
      messages: ctx.messages,
      stream: true
    }, c.body || {});

    // 记忆默认不塞进请求体的自定义字段（严格的上游会因未知参数返回 400），
    // 而是由 Widget 转成一条 system 消息放进 messages。想让后端拿到原始对象时
    // 把 memoryForward 设成 'body'。
    if (c.memoryForward === 'body' && ctx.memory && Object.keys(ctx.memory).length) {
      body.memory = ctx.memory;
    }
    if (ctx.knowledge && ctx.knowledge.enabled !== false) {
      body.knowledge = ctx.knowledge;
    }

    // 业务上下文随每一次请求下发（文档里承诺过的行为）：宿主用它告诉自有后端
    // "用户此刻在哪一页、在看哪个商品/仓库"，后端才能据此检索知识库或答得具体。
    // **只有调用方显式传了 extraInfo 才发** —— 直连第三方上游时多一个未知字段会被
    // 400 拒掉，所以不能像 knowledge 那样无条件塞。
    if (c.extraInfo) {
      var extra = null;
      try { extra = (typeof c.extraInfo === 'function') ? c.extraInfo() : c.extraInfo; }
      catch (e) { extra = null; }
      if (extra && typeof extra === 'object' && Object.keys(extra).length) {
        body.extraInfo = extra;
      }
    }

    var res = await fetch(c.endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: ctx.signal
    });
    if (!res.ok) throw HttpError(res.status, await safeText(res));

    var ct = res.headers.get('content-type') || '';
    if (ct.indexOf('text/event-stream') === -1) {
      var json = await res.json().catch(function () { return null; });
      var picked = pickContent(json);
      if (picked.text && ctx.onDelta) ctx.onDelta(picked.text, picked.text);
      if (picked.references && ctx.onReferences) ctx.onReferences(picked.references);
      return picked.text;
    }

    var text = '';
    for await (var data of readSSE(res)) {
      if (data === '[DONE]') break;
      var chunk;
      try { chunk = JSON.parse(data); } catch (e) { continue; }
      if (chunk.error) throw new Error(chunk.error.message || '上游返回错误');

      // 有些网关把知识库命中放在每个 chunk 的同一字段里，只在第一次给全量
      if (ctx.onReferences) {
        var refs = pickReferences(chunk);
        if (refs.length) ctx.onReferences(refs);
      }

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
    var prompt = ctx.messages
      .filter(function (m) { return m.role !== 'system'; })
      .map(function (m) { return (m.role === 'user' ? '用户：' : '助手：') + m.content; })
      .join('\n') + '\n助手：';

    var input = Object.assign({ prompt: prompt }, c.sessionId ? { session_id: c.sessionId } : {});
    // 智能体应用的知识库检索开关与参数走 parameters
    if (ctx.knowledge && ctx.knowledge.enabled !== false) {
      input.prompt = prompt;
    }

    var res = await fetch(
      (c.endpoint || 'https://dashscope.aliyuncs.com') + '/api/v1/apps/' + encodeURIComponent(appId) + '/completion',
      {
        method: 'POST',
        headers: Object.assign({
          'Content-Type': 'application/json',
          'X-DashScope-SSE': 'enable'
        }, authHeaders(c), c.headers || {}),
        body: JSON.stringify({
          input: input,
          parameters: Object.assign({}, c.parameters || {}),
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
      if (ctx.onReferences) {
        var refs = pickReferences(chunk);
        if (refs.length) ctx.onReferences(refs);
      }
      var piece = chunk.output && chunk.output.text;
      if (piece) { text += piece; ctx.onDelta(piece, text); }
    }
    return text;
  };

  /**
   * Anthropic Messages API（/v1/messages）。
   * 它的请求/响应形状和 OpenAI 都不一样：system 是顶层字段、SSE 事件按 type 分，
   * 正文在 content_block_delta.delta.text 里。所以单独一个适配器。
   */
  transports.anthropic = async function (ctx) {
    var c = ctx.config;
    if (!c.endpoint) throw new Error('缺少 endpoint（或指定 provider: "anthropic"）');

    // Anthropic 把 system 放在顶层，不放在 messages 里
    var sys = ctx.messages.filter(function (m) { return m.role === 'system'; })
      .map(function (m) { return m.content; }).join('\n\n');
    var msgs = ctx.messages.filter(function (m) { return m.role !== 'system'; })
      .map(function (m) { return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }; });

    var headers = Object.assign({
      'Content-Type': 'application/json',
      'anthropic-version': c.anthropicVersion || '2023-06-01'
    }, authHeaders(Object.assign({ auth: 'x-api-key' }, c)), c.headers || {});
    // 从浏览器直接调 Anthropic 需要显式放行，否则会被 CORS 拦掉——
    // 生产环境请走后端代理，见 references/self-hosted-widget.md
    if (c.allowBrowserDirect) headers['anthropic-dangerous-direct-browser-access'] = 'true';

    var res = await fetch(c.endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(Object.assign({
        model: c.model,
        max_tokens: c.maxTokens || 2048,
        messages: msgs,
        stream: true
      }, sys ? { system: sys } : {}, c.body || {})),
      signal: ctx.signal
    });
    if (!res.ok) throw HttpError(res.status, await safeText(res));

    var ct = res.headers.get('content-type') || '';
    if (ct.indexOf('text/event-stream') === -1) {
      var json = await res.json().catch(function () { return null; });
      var whole = (json && json.content || []).filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text; }).join('');
      if (whole && ctx.onDelta) ctx.onDelta(whole, whole);
      return whole;
    }

    var text = '';
    for await (var data of readSSE(res)) {
      if (!data || data === '[DONE]') continue;
      var ev;
      try { ev = JSON.parse(data); } catch (e) { continue; }
      if (ev.type === 'error') throw new Error((ev.error && ev.error.message) || '上游返回错误');
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.text) {
        text += ev.delta.text;
        ctx.onDelta(ev.delta.text, text);
      }
      if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason === 'max_tokens') {
        text += '\n\n（已达单次回复长度上限）';
        ctx.onDelta('', text);
      }
    }
    return text;
  };

  /**
   * 从各种可能的上游形状里捞出正文。
   * 自建 RAG 后端常见的返回形状都会被认出来，省得每个项目都写一遍适配。
   */
  function pickContent(json) {
    if (!json) return { text: '', references: [] };
    var text = '';
    var c = json.choices && json.choices[0];
    if (c) text = (c.message && c.message.content) || c.text || '';
    if (!text && json.output) text = json.output.text || (json.output.choices && json.output.choices[0] && json.output.choices[0].message.content) || '';
    if (!text && typeof json.answer === 'string') text = json.answer;
    if (!text && typeof json.text === 'string') text = json.text;
    return { text: text || '', references: pickReferences(json) };
  }

  /**
   * 从各种可能的上游形状里捞出知识库引用。
   * 认识这几种（都见过真实项目在用）：
   *   references / citations / sources / search_info / doc_references
   * 每项可取 title|name|doc_name、url|link|doc_url、snippet|content|text。
   */
  function pickReferences(json) {
    if (!json) return [];
    var raw = json.references || json.citations || json.sources || json.doc_references ||
      (json.output && (json.output.search_info || json.output.references)) ||
      (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.references);
    if (!raw) return [];
    // DashScope 的 search_info 是 { search_results: [...] }
    if (raw.search_results) raw = raw.search_results;
    if (!Array.isArray(raw)) return [];
    return raw.map(function (r) {
      if (typeof r === 'string') return { title: r };
      return {
        title: r.title || r.name || r.doc_name || r.document_name || r.source || '参考资料',
        url: r.url || r.link || r.doc_url || r.document_url || '',
        snippet: (r.snippet || r.content || r.text || r.chunk || '').toString().slice(0, 240)
      };
    }).filter(function (r) { return r.title || r.snippet; }).slice(0, 8);
  }

  /* ────────────────────────────────────────────────────────────
   * 存储：会话历史 + 记忆 + 界面状态
   *
   * 全部收在一个键下，方便"删干净"和排查：
   *   { threads: [...], activeId, memory: {...}, ui: { launcherPos } }
   * ──────────────────────────────────────────────────────────── */

  function Store(opts) {
    this.key = opts.storageKey || 'waa';
    this.driver = null;
    if (opts.storage !== 'none') {
      try {
        this.driver = opts.storage === 'local' ? global.localStorage : global.sessionStorage;
        // 隐私模式下访问也可能抛错，探一次
        this.driver.setItem(this.key + ':probe', '1');
        this.driver.removeItem(this.key + ':probe');
      } catch (e) { this.driver = null; }
    }
    this.state = this._read();
  }

  Store.prototype._blank = function () {
    return { threads: [], activeId: null, memory: {}, ui: {}, pending: null };
  };

  Store.prototype._read = function () {
    if (!this.driver) return this._blank();
    try {
      var raw = this.driver.getItem(this.key);
      if (!raw) return this._blank();
      var s = JSON.parse(raw);
      var b = this._blank();
      return {
        threads: Array.isArray(s.threads) ? s.threads : b.threads,
        activeId: s.activeId || null,
        memory: (s.memory && typeof s.memory === 'object') ? s.memory : b.memory,
        pending: s.pending || null,
        ui: (s.ui && typeof s.ui === 'object') ? s.ui : b.ui
      };
    } catch (e) { return this._blank(); }
  };

  Store.prototype.save = function () {
    if (!this.driver) return;
    try { this.driver.setItem(this.key, JSON.stringify(this.state)); }
    catch (e) { /* 配额满或隐私模式：功能降级，但不该让挂件崩掉 */ }
  };

  Store.prototype.clear = function () {
    if (!this.driver) return;
    try { this.driver.removeItem(this.key); } catch (e) { /* 忽略 */ }
    this.state = this._blank();
  };

  /* ────────────────────────────────────────────────────────────
   * 文案
   * ──────────────────────────────────────────────────────────── */

  var COPY = {
    zh: {
      open: '打开助手', close: '关闭', send: '发送', stop: '停止',
      input: '输入你的问题…', retry: '重试', thinking: '正在回答',
      online: '在线', offline: '连接中断',
      newChat: '新对话', history: '历史记录', hot: '热词',
      shortcuts: '快捷键', back: '返回',
      shortcutsNote: '站点自己的输入框里不会抢这些键。按 Esc 关闭。',
      nativeGroup: '输入框里用系统默认键（挂件不绑定、不拦截）',
      offlineLabel: '离线', offlineBadge: '离线应答', resending: '补发中',
      setup: '配置模型', setupGear: '配置模型与密钥',
      setupEmpty: '还没配置模型。点这里选一个服务商、填入密钥就能用。',
      setupProvider: '服务商', setupProviderCustom: '自定义（手动填地址）',
      setupKey: 'API Key', setupModel: '模型', setupEndpoint: '接口地址',
      setupModelHint: '留空用服务商的默认模型', setupEndpointHint: '留空用服务商的默认地址',
      setupTest: '测试连接', setupSave: '保存并应用', setupReset: '清除配置',
      setupTesting: '正在测试…', setupOk: '连接正常', setupFail: '连接失败',
      setupSaved: '已保存，立即生效', setupCleared: '已清除本机配置',
      setupWarn: '密钥只存在这台设备的浏览器里。公开站点请关掉配置面板（setup: false），把密钥放到后端。',
      offlineFallback: '现在没有网络连接。这个问题我已经记下，联网后会自动补发。',
      offlineFallbackNoQueue: '现在没有网络连接，暂时没法回答这个问题。',
      copyBtn: '复制', copied: '已复制', copyFail: '复制失败', stopped: '已停止',
      memory: '记忆', memoryEmpty: '还没有记住任何信息',
      memoryClear: '清空记忆', clearAll: '清空全部', refs: '参考资料',
      emptyTitle: '新对话', untitled: '新对话', delete: '删除', justNow: '刚刚'
    },
    en: {
      open: 'Open assistant', close: 'Close', send: 'Send', stop: 'Stop',
      input: 'Ask a question…', retry: 'Retry', thinking: 'Answering',
      online: 'Online', offline: 'Disconnected',
      newChat: 'New chat', history: 'History', hot: 'Trending',
      shortcuts: 'Shortcuts', back: 'Back',
      shortcutsNote: 'These keys are not captured while typing in the site\u2019s own inputs. Press Esc to close.',
      nativeGroup: 'System keys inside the input (the widget neither binds nor intercepts them)',
      offlineLabel: 'Offline', offlineBadge: 'Offline answer', resending: 'Resending',
      setup: 'Configure model', setupGear: 'Configure model and API key',
      setupEmpty: 'No model configured yet. Pick a provider and paste a key to get started.',
      setupProvider: 'Provider', setupProviderCustom: 'Custom (enter the URL yourself)',
      setupKey: 'API key', setupModel: 'Model', setupEndpoint: 'Endpoint',
      setupModelHint: 'Leave blank for the provider default', setupEndpointHint: 'Leave blank for the provider default',
      setupTest: 'Test connection', setupSave: 'Save and apply', setupReset: 'Clear',
      setupTesting: 'Testing…', setupOk: 'Connection OK', setupFail: 'Connection failed',
      setupSaved: 'Saved and applied', setupCleared: 'Local config cleared',
      setupWarn: 'The key is stored only in this browser. On a public site, turn the setup panel off (setup: false) and keep the key on your backend.',
      offlineFallback: 'No network right now. I\u2019ve kept your question and will send it once the connection is back.',
      offlineFallbackNoQueue: 'No network right now, so I can\u2019t answer this one yet.',
      copyBtn: 'Copy', copied: 'Copied', copyFail: 'Copy failed', stopped: 'Stopped',
      memory: 'Memory', memoryEmpty: 'Nothing remembered yet',
      memoryClear: 'Clear memory', clearAll: 'Clear all', refs: 'Sources',
      emptyTitle: 'New chat', untitled: 'New chat', delete: 'Delete', justNow: 'just now'
    }
  };

  /* ────────────────────────────────────────────────────────────
   * 大模型服务商预设
   *
   * 这里只固化"管道形状"——地址、鉴权方式、协议适配器，
   * 以及一个**建议的**默认模型名。模型名各家都在快速迭代，
   * 以官方文档为准；用 model 覆盖即可，不用改这里的代码。
   * ──────────────────────────────────────────────────────────── */

  var PROVIDERS = {
    openai: {
      label: 'OpenAI',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini', transport: 'openai', auth: 'bearer'
    },
    dashscope: {
      label: '阿里云百炼（OpenAI 兼容模式）',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      model: 'qwen-plus', transport: 'openai', auth: 'bearer'
    },
    dashscopeApp: {
      label: '阿里云百炼（智能体应用）',
      endpoint: 'https://dashscope.aliyuncs.com',
      model: '', transport: 'dashscopeApp', auth: 'bearer', needsAppId: true
    },
    deepseek: {
      label: 'DeepSeek',
      endpoint: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat', transport: 'openai', auth: 'bearer'
    },
    moonshot: {
      label: '月之暗面 Kimi',
      endpoint: 'https://api.moonshot.cn/v1/chat/completions',
      model: 'moonshot-v1-8k', transport: 'openai', auth: 'bearer'
    },
    zhipu: {
      label: '智谱 GLM',
      endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      model: 'glm-4-flash', transport: 'openai', auth: 'bearer'
    },
    siliconflow: {
      label: 'SiliconFlow 硅基流动',
      endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
      model: 'Qwen/Qwen2.5-7B-Instruct', transport: 'openai', auth: 'bearer'
    },
    openrouter: {
      label: 'OpenRouter',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'openai/gpt-4o-mini', transport: 'openai', auth: 'bearer'
    },
    ollama: {
      label: 'Ollama（本机）',
      endpoint: 'http://localhost:11434/v1/chat/completions',
      model: 'qwen2.5', transport: 'openai', auth: 'none'
    },
    vllm: {
      label: 'vLLM / 自建网关',
      endpoint: 'http://localhost:8000/v1/chat/completions',
      model: '', transport: 'openai', auth: 'bearer'
    },
    anthropic: {
      label: 'Anthropic Claude',
      endpoint: 'https://api.anthropic.com/v1/messages',
      model: 'claude-sonnet-4-6', transport: 'anthropic', auth: 'x-api-key'
    }
  };

  /**
   * 把 provider 预设铺进**原始**配置里（必须在合并 DEFAULTS 之前调用，
   * 否则分不清"用户显式传了 transport"和"默认值填的 transport"）。
   * 显式传的 endpoint / model / transport 永远优先于预设——
   * 预设只是省去抄地址，不是一个"你必须接受"的约定。
   */
  function applyProvider(o) {
    var name = o.provider;
    if (!name) return o;
    var p = PROVIDERS[name];
    if (!p) {
      if (global.console && console.warn) {
        console.warn('[web-ai-assistant] 未知的 provider：' + name +
          '。可选：' + Object.keys(PROVIDERS).join(' / '));
      }
      return o;
    }
    o.providerLabel = p.label;
    if (!o.transport) o.transport = p.transport;
    if (!o.endpoint) o.endpoint = p.endpoint;
    if (!o.model) o.model = p.model;
    if (!o.auth) o.auth = p.auth;
    return o;
  }

  /* ────────────────────────────────────────────────────────────
   * 快捷键
   *
   * 组合键写法："mod+k"（Mac 上是 ⌘，其它平台是 Ctrl）、"alt+arrowup"、
   * "escape"、"shift+enter"。用 hotkeys 配置项按动作名覆盖。
   * ──────────────────────────────────────────────────────────── */

  var IS_MAC = /mac|iphone|ipad|ipod/i.test(
    (global.navigator && (global.navigator.platform || global.navigator.userAgent)) || ''
  );

  var SHORTCUTS = [
    { id: 'toggle',    combo: 'mod+k',         scope: 'global', zh: '打开 / 收起助手',       en: 'Open / close assistant' },
    { id: 'help',      combo: 'mod+/',         scope: 'global', zh: '显示快捷键',             en: 'Show shortcuts' },
    { id: 'history',   combo: 'mod+shift+h',   scope: 'global', zh: '历史与记忆',             en: 'History & memory' },
    { id: 'newChat',   combo: 'mod+shift+o',   scope: 'global', zh: '新对话',                 en: 'New chat' },
    { id: 'close',     combo: 'escape',        scope: 'panel',  zh: '收起（抽屉打开时先关抽屉）', en: 'Close (closes drawer first)' },
    { id: 'prevChat',  combo: 'alt+arrowup',   scope: 'panel',  zh: '上一个会话',             en: 'Previous chat' },
    { id: 'nextChat',  combo: 'alt+arrowdown', scope: 'panel',  zh: '下一个会话',             en: 'Next chat' },
    { id: 'send',      combo: 'enter',         scope: 'input',  zh: '发送',                   en: 'Send' },
    { id: 'newline',   combo: 'shift+enter',   scope: 'input',  zh: '换行',                   en: 'New line' },
    { id: 'sendAny',   combo: 'mod+enter',     scope: 'input',  zh: '发送（任何情况下）',      en: 'Send (always)' },
    { id: 'editLast',  combo: 'arrowup',       scope: 'input',  zh: '取回上一条提问（输入框为空时）', en: 'Recall last question (empty input)' }
  ];

  /**
   * 输入框里的系统默认键。挂件既不绑定也不拦截它们，
   * 这里只负责"列出来让用户知道它们还在"——用户看不到，就会以为被挂件吃掉了。
   */
  var NATIVE_KEYS = [
    { combo: 'mod+c', zh: '复制选中的内容', en: 'Copy' },
    { combo: 'mod+x', zh: '剪切', en: 'Cut' },
    { combo: 'mod+v', zh: '粘贴', en: 'Paste' },
    { combo: 'mod+a', zh: '全选输入框内容', en: 'Select all' },
    { combo: 'mod+z', zh: '撤销', en: 'Undo' },
    { combo: 'mod+shift+z', zh: '重做', en: 'Redo' },
    { combo: 'mod+f', zh: '页内查找（浏览器自己的）', en: 'Find in page (the browser\u2019s own)' }
  ];

  function parseCombo(s) {
    var o = { mod: false, alt: false, shift: false, ctrl: false, meta: false, key: '' };
    String(s).toLowerCase().split('+').forEach(function (p) {
      p = p.trim();
      if (!p) return;
      if (p === 'mod') o.mod = true;
      else if (p === 'alt' || p === 'option') o.alt = true;
      else if (p === 'shift') o.shift = true;
      else if (p === 'ctrl' || p === 'control') o.ctrl = true;
      else if (p === 'meta' || p === 'cmd' || p === 'command') o.meta = true;
      else o.key = p;
    });
    return o;
  }

  // 解析结果缓存。注意不能挂在 combo 字符串上（'use strict' 下给原始值设属性会抛错），
  // 必须用独立的表。
  var COMBO_CACHE = {};

  function matchCombo(combo, e) {
    var c = COMBO_CACHE[combo] || (COMBO_CACHE[combo] = parseCombo(combo));
    var key = String(e.key || '').toLowerCase();
    if (key === ' ') key = 'space';
    if (c.key !== key) return false;
    if (!!c.alt !== !!e.altKey) return false;
    if (!!c.shift !== !!e.shiftKey) return false;
    var modDown = IS_MAC ? !!e.metaKey : !!e.ctrlKey;
    if (c.mod !== modDown) return false;
    if (!c.mod) {
      // 没写 mod 的组合键不能被 Ctrl/Cmd 触发，否则 "enter" 会连 Ctrl+Enter 一起吃掉
      if (IS_MAC ? e.metaKey : e.ctrlKey) return false;
    }
    return true;
  }

  function fmtCombo(combo) {
    var c = parseCombo(combo);
    var out = [];
    if (c.mod) out.push(IS_MAC ? '⌘' : 'Ctrl');
    else if (c.meta) out.push('⌘');
    else if (c.ctrl) out.push('Ctrl');
    if (c.alt) out.push(IS_MAC ? '⌥' : 'Alt');
    if (c.shift) out.push(IS_MAC ? '⇧' : 'Shift');
    var names = {
      arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
      escape: 'Esc', enter: IS_MAC ? '↩' : 'Enter', space: 'Space'
    };
    out.push(names[c.key] || (c.key.length === 1 ? c.key.toUpperCase()
      : c.key.charAt(0).toUpperCase() + c.key.slice(1)));
    return out;
  }

  function isEditable(el) {
    if (!el || !el.tagName) return false;
    var t = el.tagName.toLowerCase();
    if (t === 'textarea') return true;
    if (t === 'input') return !/^(button|checkbox|radio|submit|reset|file|range|color)$/i.test(el.type || '');
    return !!el.isContentEditable;
  }

  /** 归一化组合键，用来比对"是不是撞上了保留键" */
  function normCombo(s) {
    var c = parseCombo(s);
    var mods = [];
    if (c.mod || c.ctrl || c.meta) mods.push('mod');
    if (c.alt) mods.push('alt');
    if (c.shift) mods.push('shift');
    mods.sort();
    return (mods.length ? mods.join('+') + '+' : '') + c.key;
  }

  /**
   * 浏览器/操作系统自己管的键，挂件绝不能碰。
   * 复制、剪切、粘贴、全选、撤销这些在输入框里必须照常工作——
   * 一个聊天挂件把用户的 Ctrl+C 吃掉，是比少一个快捷键严重得多的事故。
   * 用户把这些键绑到某个动作上时，我们不接受，退回默认组合键并出声警告。
   */
  var RESERVED = [
    'mod+c', 'mod+x', 'mod+v', 'mod+a', 'mod+z', 'mod+shift+z', 'mod+y',
    'mod+f', 'mod+n', 'mod+t', 'mod+w', 'mod+p', 'mod+s', 'mod+l', 'mod+r',
    'mod+shift+n', 'mod+shift+t', 'mod+shift+w', 'mod+shift+v',
    'mod+shift+i', 'mod+shift+j', 'mod+shift+c', 'mod+shift+delete'
  ].map(normCombo);

  function isReserved(combo) {
    return RESERVED.indexOf(normCombo(combo)) !== -1;
  }

  /**
   * 离线行为。
   * 访客在地铁里、电梯里、弱网酒店里都会碰到，而"转圈转到天荒地老"是最差的回应。
   * 三层：本地问答命中就直接答 → 答不了就给一句人话并记住这条问题 → 恢复联网自动补发。
   *
   * 只保留**一条**待补发的问题（后来者覆盖先前的）。做成队列看起来更"完整"，
   * 但一条条插回历史里重放会把上下文搅乱；只留最新一条是能保证正确的做法，
   * 更早没答上的问题仍留在对话里，用户看得见。
   */
  var OFFLINE_DEFAULTS = {
    enabled: true,
    answers: [],      // [{ match: '正则或子串', reply: '...' }]
    resend: true,     // 恢复联网后自动补发那条没答上的问题
    fallback: ''      // 留空用内置文案
  };

  var DEFAULTS = {
    name: '助手',
    locale: 'zh',
    provider: '',             // 见 PROVIDERS：openai / dashscope / deepseek / ollama / anthropic …
    transport: 'openai',      // 显式指定时优先于 provider 预设
    auth: '',                 // 'bearer' | 'x-api-key' | 'none'，留空则跟随 provider
    endpoint: '',
    model: '',
    apiKey: '',
    appId: '',
    headers: null,
    body: null,

    greeting: '',
    suggestions: [],          // 预置问题（精选，短列表）
    hotWords: null,           // 热词：['a','b'] 或 [{text, weight}]
    hotWordsUrl: '',          // 从后端拉热词，返回数组或 {items:[]}
    hotWordsRefresh: 0,       // 毫秒；>0 时定时重拉
    hotWordsPlacement: 'both',// 'empty' | 'composer' | 'both' | 'off'

    theme: 'auto',            // auto | light | dark
    position: 'right',        // right | left
    draggable: true,
    autoOpen: false,
    closeOnOutsideClick: true,
    closeOnEsc: true,
    // 业务自己的浮层（下拉、日期选择器…）通常挂在 document.body 上，
    // 点它会被判定成"外部点击"。把这些元素的选择器放进来即可豁免。
    outsideIgnore: null,

    shortcuts: true,          // 总开关
    hotkeys: null,            // { toggle: 'mod+shift+k', … } 按动作名覆盖默认组合键
    shortcutHelp: true,       // 是否提供快捷键help面板
    offline: null,            // 见 OFFLINE_DEFAULTS
    /**
     * 在挂件里内置一个「选服务商 + 填 key + 测连接」的配置面板。
     * 默认 **关**：公开站点上绝不能让访客看到它，更不能让 key 落进访客浏览器。
     * 本机开发、内网工具、Electron 壳这类场景打开它，省掉改代码重启那一圈。
     */
    setup: false,
    setupNote: '',            // 面板底部的自定义提示

    storage: 'session',       // session | local | none
    storageKey: 'waa',
    maxThreads: 40,
    history: true,            // 多会话历史

    memory: true,             // 持久化并随请求发送用户记忆
    memorySystem: true,       // 把记忆拼成 system 消息（兼容性最好）
    memoryForward: 'system',  // 'system' | 'body'
    memoryPrompt: '以下是关于当前访客的已知信息，请在回答时自然地参考，不要逐条复述：',

    knowledge: null,          // { enabled, id, name, topK, mode } —— 见 self-hosted-widget.md
    retrieve: null,           // async (query, {messages}) => [{title,url,snippet}] 前端检索钩子

    zIndex: 2147483000,
    accent: '',
    radius: '',
    css: '',
    cssUrl: '',
    extraInfo: null,
    onBeforeSend: null,
    onAfterSend: null,
    onError: null,
    onThreadChange: null,
    echoReply: ''
  };

  /* ────────────────────────────────────────────────────────────
   * 挂件
   * ──────────────────────────────────────────────────────────── */

  var idSeq = 0;

  function uid(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function Widget(options) {
    this._baseOptions = Object.assign({}, options || {});
    var raw = applyProvider(Object.assign({}, options || {}));
    this.opts = Object.assign({}, DEFAULTS, raw);
    // 兼容 v1 的 persist:false
    if (this.opts.persist === false) this.opts.storage = 'none';
    if (this.opts.persist === true && this.opts.storage === 'session') this.opts.storage = 'local';
    this.scriptEl = this.opts.scriptEl || null;
    this.copy = COPY[this.opts.locale] || COPY.zh;

    this.store = new Store(this.opts);
    // 面板里存下来的配置优先于代码里的：用户刚在界面上改过的东西，不该被刷新覆盖掉
    this._applyStoredConfig();
    // offline 要单独深合并：Object.assign 会把整个对象换掉，用户只传 answers 时
    // enabled / queue 这些就会被抹成 undefined
    this.opts.offline = Object.assign({}, OFFLINE_DEFAULTS, this.opts.offline || {});
    this.memory = this.store.state.memory || {};
    this.hot = normalizeHot(this.opts.hotWords);
    this.busy = false;
    this.abort = null;
    this.id = 'waa-' + (++idSeq);
    this.openState = false;
    this.drawerOpen = false;

    this._ensureThread();
    this._build();
  }

  /**
   * 要不要显示配置入口。
   *   setup: true    → 一直显示（本机开发、内网工具）
   *   setup: 'auto'  → 只有"看起来还没配好"时才显示（provider 预设但没填 key）
   *   setup: false   → 永不显示（公开站点，默认）
   */
  Widget.prototype._needsSetup = function () {
    if (this.store.state.config) return false;
    var t = this.opts.transport;
    if (['openai', 'anthropic', 'dashscopeApp'].indexOf(t) === -1) return false;
    if (!this.opts.endpoint) return true;
    var keyless = this.opts.auth === 'none' || /localhost|127\.0\.0\.1/.test(this.opts.endpoint);
    return !keyless && !this.opts.apiKey;
  };

  Widget.prototype._setupVisible = function () {
    if (!this.opts.setup) return false;
    return this.opts.setup === 'auto' ? this._needsSetup() : true;
  };

  /* ── 本机配置（setup 面板） ──────────────────────────────── */

  var CONFIG_KEYS = ['provider', 'transport', 'endpoint', 'model', 'apiKey', 'appId', 'auth'];

  Widget.prototype._applyStoredConfig = function () {
    var cfg = this.store.state.config;
    if (!cfg) return;
    // 无论如何都合并：面板存过一次就代表用户明确表达过意图。
    // （面板本身由 opts.setup 控制是否显示，跟这份配置要不要生效是两件事。）
    var merged = applyProvider(Object.assign({}, cfg));
    for (var i = 0; i < CONFIG_KEYS.length; i++) {
      var k = CONFIG_KEYS[i];
      if (merged[k]) this.opts[k] = merged[k];
    }
    this.opts.provider = merged.provider || this.opts.provider;
    this.opts.providerLabel = merged.providerLabel || this.opts.providerLabel;
  };

  Widget.prototype.getConfig = function () {
    var self = this;
    var out = {};
    CONFIG_KEYS.forEach(function (k) { if (self.opts[k]) out[k] = self.opts[k]; });
    return out;
  };

  /** 应用一份新配置并持久化，立刻生效——不用刷新页面 */
  Widget.prototype.setConfig = function (cfg) {
    var merged = applyProvider(Object.assign({}, cfg || {}));
    // 选"自定义"（没有预设）时 applyProvider 不会填 transport，
    // 这里必须保留当前值，否则会把 transport 清成空串、挂件直接失灵
    if (!merged.transport) merged.transport = this.opts.transport || DEFAULTS.transport;
    for (var i = 0; i < CONFIG_KEYS.length; i++) {
      var k = CONFIG_KEYS[i];
      // 显式清成空串的字段要真的清掉，否则换了服务商还在用旧地址
      this.opts[k] = merged[k] || '';
    }
    this.opts.provider = merged.provider || '';
    this.opts.providerLabel = merged.providerLabel || '';
    this.store.state.config = this.getConfig();
    this.store.save();
    this._syncProviderLabel();
    return this.getConfig();
  };

  Widget.prototype.resetConfig = function () {
    this.store.state.config = null;
    this.store.save();
    // 回到代码里传进来的那份配置
    var base = applyProvider(Object.assign({}, this._baseOptions || {}));
    var next = Object.assign({}, DEFAULTS, base);
    for (var i = 0; i < CONFIG_KEYS.length; i++) {
      var k = CONFIG_KEYS[i];
      this.opts[k] = next[k] || '';
    }
    this.opts.provider = next.provider || '';
    this._syncProviderLabel();
    return this.getConfig();
  };

  /** 装配一份候选配置，供测试连接用 */
  Widget.prototype._probe = function (cfg) {
    var opts = applyProvider(Object.assign({}, this.opts, cfg));
    var fn = typeof opts.transport === 'function' ? opts.transport : transports[opts.transport];
    if (!fn) return Promise.reject(new Error('未知 transport：' + opts.transport));
    if (!opts.endpoint) return Promise.reject(new Error('缺少接口地址'));

    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, this.opts.setupTimeout || 20000);
    var ctx = {
      messages: [{ role: 'user', content: 'ping' }],
      // 把回复压到最短，测试不该花钱
      config: Object.assign({}, opts, {
        body: Object.assign({ max_tokens: 8 }, opts.body || {}),
        maxTokens: 8
      }),
      signal: ctrl ? ctrl.signal : null,
      onDelta: function () {},
      onReferences: function () {}
    };
    var self = this;
    return Promise.resolve(fn(ctx)).then(function (r) {
      clearTimeout(timer);
      var text = typeof r === 'string' ? r : (r && r.text) || '';
      if (!text) throw new Error('通了，但返回为空');
      return text;
    }, function (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('超时（' + ((self.opts.setupTimeout || 20000) / 1000) + 's）');
      throw e;
    });
  };

  Widget.prototype._syncProviderLabel = function () {
    // 配置面板改过之后，标题栏的副标题跟着更新，不然用户不知道现在连的是哪家
    if (this.headMeta && this.opts.providerLabel && this.opts.setup) {
      this.headMeta.setAttribute('data-provider', this.opts.providerLabel);
    }
  };

  /* ── 线程 ─────────────────────────────────────────────────── */

  Widget.prototype._ensureThread = function () {
    var s = this.store.state;
    var t = s.threads.filter(function (x) { return x.id === s.activeId; })[0];
    if (!t) {
      t = this._newThreadObject();
      s.threads.unshift(t);
      s.activeId = t.id;
      this.store.save();
    }
    this.thread = t;
  };

  Widget.prototype._newThreadObject = function () {
    return { id: uid('t'), createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  };

  Widget.prototype._titleOf = function (t) {
    var first = (t.messages || []).filter(function (m) { return m.role === 'user'; })[0];
    if (!first) return this.copy.untitled;
    var s = String(first.content).replace(/\s+/g, ' ').trim();
    return s.length > 18 ? s.slice(0, 18) + '…' : s;
  };

  Widget.prototype._sortThreads = function () {
    this.store.state.threads.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  };

  Widget.prototype.newThread = function () {
    var s = this.store.state;
    // 已经是一个空的新对话就别再堆一个
    var cur = this.thread;
    if (cur && cur.messages.length === 0) { this._renderAll(); return cur; }
    var t = this._newThreadObject();
    s.threads.unshift(t);
    s.activeId = t.id;
    this._prune();
    this.store.save();
    this.thread = t;
    this._renderAll();
    this._notifyThread();
    if (this.openState) this.input.focus();
    return t;
  };

  Widget.prototype.openThread = function (id) {
    var t = this.store.state.threads.filter(function (x) { return x.id === id; })[0];
    if (!t) return false;
    this.store.state.activeId = id;
    this.store.save();
    this.thread = t;
    this._renderAll();
    this._closeDrawer();
    this._notifyThread();
    return true;
  };

  Widget.prototype.deleteThread = function (id) {
    var s = this.store.state;
    s.threads = s.threads.filter(function (x) { return x.id !== id; });
    if (s.activeId === id) {
      s.activeId = s.threads[0] ? s.threads[0].id : null;
    }
    this.store.save();
    this._ensureThread();
    this._renderAll();
    this._notifyThread();
  };

  Widget.prototype.listThreads = function () {
    this._sortThreads();
    var self = this;
    return this.store.state.threads.map(function (t) {
      return { id: t.id, title: self._titleOf(t), updatedAt: t.updatedAt, count: t.messages.length, active: t.id === self.thread.id };
    });
  };

  Widget.prototype.clearAll = function () {
    this.store.clear();
    this.memory = {};
    this._ensureThread();
    this._renderAll();
    this._notifyThread();
  };

  Widget.prototype._prune = function () {
    var s = this.store.state;
    var max = this.opts.maxThreads || 40;
    if (s.threads.length <= max) return;
    // 先丢空的，再丢最旧的
    this._sortThreads();
    s.threads = s.threads.slice(0, max);
    if (!s.threads.some(function (t) { return t.id === s.activeId; })) {
      s.activeId = s.threads[0] ? s.threads[0].id : null;
    }
  };

  Widget.prototype._notifyThread = function () {
    if (typeof this.opts.onThreadChange === 'function') {
      try { this.opts.onThreadChange(this.listThreads()); } catch (e) { /* 忽略 */ }
    }
  };

  /* ── 记忆 ─────────────────────────────────────────────────── */

  /** 记一件事。传对象则合并；同名字段覆盖。 */
  Widget.prototype.remember = function (facts) {
    if (!facts || typeof facts !== 'object') return this.getMemory();
    Object.assign(this.memory, facts);
    this.store.state.memory = this.memory;
    this.store.save();
    if (this.drawerOpen) this._renderDrawer();
    return this.getMemory();
  };

  Widget.prototype.forget = function (keys) {
    if (!keys) this.memory = {};
    else {
      (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete this.memory[k]; }, this);
    }
    this.store.state.memory = this.memory;
    this.store.save();
    if (this.drawerOpen) this._renderDrawer();
    return this.getMemory();
  };

  Widget.prototype.getMemory = function () {
    return Object.assign({}, this.memory);
  };

  Widget.prototype._memoryMessages = function () {
    if (!this.opts.memory || this.opts.memoryForward === 'body') return [];
    var keys = Object.keys(this.memory).filter(function (k) {
      var v = this.memory[k];
      return v !== '' && v != null;
    }, this);
    if (!keys.length) return [];
    var lines = keys.map(function (k) { return '- ' + k + '：' + String(this.memory[k]); }, this);
    return [{ role: 'system', content: this.opts.memoryPrompt + '\n' + lines.join('\n') }];
  };

  /* ── 构建界面 ─────────────────────────────────────────────── */

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
    this.localStyle = h('style', { text: this.opts.css || '' });
    root.appendChild(this.localStyle);

    var vars = [];
    if (this.opts.accent) vars.push('--waa-accent:' + this.opts.accent);
    if (this.opts.radius) vars.push('--waa-radius:' + this.opts.radius);
    this.el = h('div', {
      class: 'waa', 'data-theme': this.opts.theme, 'data-position': this.opts.position,
      'data-locale': this.opts.locale,
      style: vars.join(';')
    });
    root.appendChild(this.el);

    // ── 启动器
    this.launcher = h('button', {
      type: 'button', class: 'waa-launcher',
      'aria-label': this.copy.open, 'aria-expanded': 'false',
      onclick: function () { self.toggle(); }
    }, [
      h('span', { class: 'waa-launcher__glyph', 'aria-hidden': 'true' }, [this._glyph()]),
      h('span', { class: 'waa-launcher__badge', hidden: true })
    ]);
    // 把开关键提示挂在 title 上，用户悬停就知道有快捷键
    var toggleCombo = (this._shortcutList().filter(function (s) { return s.id === 'toggle'; })[0] || {}).combo;
    if (toggleCombo) {
      this.launcher.title = this.copy.open + ' · ' + fmtCombo(toggleCombo).join(IS_MAC ? '' : '+');
    }

    // ── 头部
    this.headMeta = h('span', { class: 'waa-head__meta', text: this.copy.online });

    this.btnNew = h('button', {
      type: 'button', class: 'waa-iconbtn', 'aria-label': this.copy.newChat, title: this.copy.newChat,
      onclick: function () { self.newThread(); }
    }, [icon(ICONS.plus)]);

    this.btnHistory = h('button', {
      type: 'button', class: 'waa-iconbtn', 'aria-label': this.copy.history, title: this.copy.history,
      onclick: function () { self._toggleDrawer(); }
    }, [icon(ICONS.list)]);

    this.btnClose = h('button', {
      type: 'button', class: 'waa-iconbtn', 'aria-label': this.copy.close,
      onclick: function () { self.close(); }
    }, [icon(ICONS.close)]);

    // 配置面板的入口。setup 关着就整个不建，免得公开站点上多一个按钮被人点到。
    this.btnSetup = this._setupVisible() ? h('button', {
      type: 'button', class: 'waa-iconbtn', 'aria-label': this.copy.setupGear, title: this.copy.setupGear,
      onclick: function () {
        self._openDrawer(self.drawerOpen && self.drawerView === 'setup' ? 'main' : 'setup');
      }
    }, [icon(ICONS.sliders)]) : null;

    // ── 抽屉（历史 + 记忆）
    this.drawer = h('div', { class: 'waa-drawer', hidden: true });

    // ── 消息区
    this.log = h('div', {
      class: 'waa-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions text'
    });

    // ── 热词条（常驻在输入框上方）
    this.hotBar = h('div', { class: 'waa-hotbar', hidden: true });

    // ── 输入区
    this.input = h('textarea', {
      class: 'waa-input', rows: '1', 'aria-label': this.copy.input, placeholder: this.copy.input
    });
    this.input.addEventListener('input', function () { self._autosize(); });
    // Enter / Shift+Enter / ↑ 等按键统一由快捷键引擎处理，见 _bindShortcuts，
    // 免得两个地方各管一半、行为互相打架。

    this.sendBtn = h('button', {
      type: 'button', class: 'waa-send', 'aria-label': this.copy.send,
      onclick: function () { self._submit(); }
    }, [h('span', { 'aria-hidden': 'true' }, [icon(ICONS.send, 17)])]);

    this.panel = h('section', {
      class: 'waa-panel', role: 'dialog', 'aria-modal': 'false',
      'aria-label': this.opts.name, hidden: true
    }, [
      h('header', { class: 'waa-head' }, [
        h('span', { class: 'waa-head__pulse', 'aria-hidden': 'true' }),
        h('h2', { class: 'waa-head__name', text: this.opts.name }),
        this.headMeta,
        this.btnSetup, this.btnNew, this.btnHistory, this.btnClose
      ]),
      h('div', { class: 'waa-body' }, [this.log, this.drawer]),
      this.hotBar,
      h('form', { class: 'waa-compose', onsubmit: function (e) { e.preventDefault(); self._submit(); } }, [
        this.input, this.sendBtn
      ])
    ]);

    this.el.appendChild(this.launcher);
    this.el.appendChild(this.panel);

    this._bindGlobal();
    this._renderAll();

    var attach = function () { (document.body || document.documentElement).appendChild(host); };
    if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach);

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

    if (this.opts.hotWordsUrl) {
      this._loadHotWords();
      if (this.opts.hotWordsRefresh > 0) {
        this._hotTimer = setInterval(function () { self._loadHotWords(); }, this.opts.hotWordsRefresh);
      }
    }
  };

  Widget.prototype._glyph = function () {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '22'); svg.setAttribute('height', '22');
    svg.setAttribute('fill', 'none');
    var outer = document.createElementNS(SVG_NS, 'path');
    outer.setAttribute('d', 'M4 5h11l5 5v9H4z');
    outer.setAttribute('stroke', 'currentColor');
    outer.setAttribute('stroke-width', '1.6');
    outer.setAttribute('stroke-linejoin', 'round');
    var lines = document.createElementNS(SVG_NS, 'path');
    lines.setAttribute('d', 'M7.5 10.5h6M7.5 14h4');
    lines.setAttribute('stroke', 'currentColor');
    lines.setAttribute('stroke-width', '1.6');
    lines.setAttribute('stroke-linecap', 'round');
    svg.appendChild(outer); svg.appendChild(lines);
    return svg;
  };

  /* ── 样式表 ───────────────────────────────────────────────── */

  Widget.prototype._injectStylesheet = function () {
    var self = this;
    if (this.opts.css) return;
    var url = this.opts.cssUrl || this._guessCssUrl();
    if (!url) {
      if (global.console && console.warn) {
        console.warn('[web-ai-assistant] 没能自动定位样式表，挂件会以无样式状态渲染。' +
          '请显式传入 cssUrl（例如 Vite: `import cssUrl from "./ai-assistant.css?url"`）或 css 字符串。');
      }
      return;
    }
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error('css ' + r.status);
      return r.text();
    }).then(function (css) {
      if (self.localStyle) self.localStyle.textContent = css;
      else self.root.appendChild(h('style', { text: css }));
    }).catch(function () {
      self.root.appendChild(h('link', { rel: 'stylesheet', href: url }));
    });
  };

  Widget.prototype._guessCssUrl = function () {
    if (this.opts.cssUrl) return this.opts.cssUrl;
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
    this._bindShortcuts();
    this._bindNetwork();

    // 点到挂件以外的任何地方就关上。
    // Shadow DOM 会把内部点击的 target 重定向成宿主元素，所以 contains 判断是准的。
    this._onDocPointerDown = function (e) {
      if (!self.openState || self.opts.closeOnOutsideClick === false) return;
      if (self.host.contains(e.target)) return;
      var ignore = self.opts.outsideIgnore;
      if (ignore && e.target && e.target.closest) {
        var list = Array.isArray(ignore) ? ignore : [ignore];
        for (var i = 0; i < list.length; i++) {
          try { if (e.target.closest(list[i])) return; } catch (err) { /* 选择器写错就当没配 */ }
        }
      }
      self.close();
    };
    document.addEventListener('pointerdown', this._onDocPointerDown, true);
  };

  /* ── 快捷键 ───────────────────────────────────────────────── */

  Widget.prototype._shortcutList = function () {
    var over = this.opts.hotkeys || {};
    var warned = false;
    return SHORTCUTS.map(function (s) {
      var custom = over[s.id];
      var combo = custom === false ? null : (custom || s.combo);
      if (combo && custom && isReserved(combo)) {
        if (!warned && global.console && console.warn) {
          warned = true;
          console.warn('[web-ai-assistant] hotkeys.' + s.id + ' = "' + custom +
            '" 撞上了浏览器保留键（复制/粘贴/全选等），已忽略该覆盖，继续用默认的 "' + s.combo + '"。');
        }
        combo = s.combo;
      }
      return {
        id: s.id,
        combo: combo,
        scope: s.scope,
        zh: s.zh,
        en: s.en
      };
    }).filter(function (s) { return s.combo; });
  };

  Widget.prototype._actions = function () {
    var self = this;
    return {
      toggle: function () { self.toggle(); },
      help: function () {
        if (!self.openState) self.open();
        self._openDrawer(self.drawerOpen && self.drawerView === 'shortcuts' ? 'main' : 'shortcuts');
      },
      history: function () {
        if (!self.openState) self.open();
        self.drawerOpen && self.drawerView === 'main' ? self._closeDrawer() : self._openDrawer('main');
      },
      newChat: function () { self.newThread(); if (!self.openState) self.open(); },
      close: function () {
        // 抽屉开着时，Esc 先关抽屉，不顺手把整个面板也收了
        if (self.drawerOpen) { self._closeDrawer(); return; }
        if (self.opts.closeOnEsc === false) return false;
        self.close();
      },
      prevChat: function () { return self._stepThread(-1); },
      nextChat: function () { return self._stepThread(1); },
      send: function () { self._submit(); },
      sendAny: function () { self._submit(); },
      newline: function () { return false; },   // 交给浏览器插换行
      editLast: function () {
        // 只在"输入框为空"时生效，否则会抢掉正常的光标上移
        if (self.input.value !== '') return false;
        var last = null;
        for (var i = self.thread.messages.length - 1; i >= 0; i--) {
          if (self.thread.messages[i].role === 'user') { last = self.thread.messages[i]; break; }
        }
        if (!last) return false;
        self.input.value = last.content;
        self._autosize();
        try { self.input.setSelectionRange(last.content.length, last.content.length); } catch (e) { /* 忽略 */ }
      }
    };
  };

  Widget.prototype._stepThread = function (dir) {
    this._sortThreads();
    var list = this.store.state.threads;
    if (list.length < 2) return false;
    var idx = list.findIndex(function (t) { return t.id === this.thread.id; }, this);
    var next = idx + dir;
    if (next < 0) next = list.length - 1;
    if (next >= list.length) next = 0;
    this.openThread(list[next].id);
    return true;
  };

  Widget.prototype._bindShortcuts = function () {
    var self = this;
    var actions = this._actions();
    this._shortcuts = this._shortcutList();

    this._onKeydown = function (e) {
      if (self.opts.shortcuts === false) return;
      // 中文/日文输入法组合过程中不能当成快捷键
      if (e.isComposing || e.keyCode === 229) return;

      // 注意：keydown 从 Shadow DOM 里冒到 document 时，target 会被重定向成宿主元素，
      // 所以 "事件是不是发生在我们的输入框里" 必须用 composedPath 的原始目标来判断。
      var origin = (e.composedPath && e.composedPath()[0]) || e.target;
      var inWidget = self.host.contains(e.target);
      var typingElsewhere = !inWidget && isEditable(origin);

      for (var i = 0; i < self._shortcuts.length; i++) {
        var s = self._shortcuts[i];
        if (!matchCombo(s.combo, e)) continue;

        var allowed;
        if (s.scope === 'global') {
          // 全局键的意义就是"在哪都能按"。但焦点在站点自己的输入框里时不抢——
          // 否则会把人家搜索框的 Ctrl+K 吃掉。
          allowed = inWidget || !typingElsewhere;
        } else if (s.scope === 'panel') {
          allowed = self.openState && (inWidget || !typingElsewhere);
        } else {
          allowed = self.openState && origin === self.input;
        }
        if (!allowed) continue;

        var fn = actions[s.id];
        if (!fn) continue;
        if (fn(e) === false) continue;   // 动作自己说不处理，就让事件继续冒泡
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    };
    document.addEventListener('keydown', this._onKeydown);
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
    this._renderHotBar();
  };

  /* ── 拖动 ─────────────────────────────────────────────────── */

  Widget.prototype._makeDraggable = function () {
    var self = this;
    var saved = this.store.state.ui && this.store.state.ui.launcherPos;
    if (saved) this._applyPos(saved, true);

    var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;

    function onDown(e) {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      var r = self.launcher.getBoundingClientRect();
      ox = r.left; oy = r.top;
      // 这里千万不能 e.preventDefault()：在 pointerdown 上阻止默认行为会连带
      // 掐掉随后的兼容性 click 事件，于是"点一下启动器"就再也打不开面板了。
      // 拖动结束那次多余的 click 由 onUp 里的捕获监听吃掉。
      try { self.launcher.setPointerCapture(e.pointerId); } catch (err) { /* 捕获失败也无所谓 */ }
    }

    // move / up 挂在 window 上而不是启动器自己：
    // 指针一旦离开那个 52px 的方块，挂在元素上的监听就收不到事件了；
    // setPointerCapture 在部分环境（含合成输入、某些移动端）并不可靠。
    function onMove(e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return; // 抖动阈值：<4px 仍算点击
      moved = true;
      self.launcher.classList.add('is-dragging');
      self._applyPos({ x: ox + dx, y: oy + dy });
    }

    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      self.launcher.classList.remove('is-dragging');
      try { self.launcher.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      if (!moved) return;
      var r = self.launcher.getBoundingClientRect();
      self.store.state.ui = self.store.state.ui || {};
      self.store.state.ui.launcherPos = { x: r.left, y: r.top };
      self.store.save();
      // 拖动结束时浏览器还会补一次 click，要吃掉它，否则会顺手把面板打开
      var stop = function (ev) {
        ev.stopPropagation(); ev.preventDefault();
        self.launcher.removeEventListener('click', stop, true);
      };
      self.launcher.addEventListener('click', stop, true);
    }

    this.launcher.addEventListener('pointerdown', onDown);
    global.addEventListener('pointermove', onMove);
    global.addEventListener('pointerup', onUp);
    global.addEventListener('pointercancel', onUp);

    this._teardownDrag = function () {
      this.launcher.removeEventListener('pointerdown', onDown);
      global.removeEventListener('pointermove', onMove);
      global.removeEventListener('pointerup', onUp);
      global.removeEventListener('pointercancel', onUp);
    };
  };

  Widget.prototype._applyPos = function (p, silent) {
    var w = this.launcher.offsetWidth || 52, hh = this.launcher.offsetHeight || 52;
    var x = Math.max(8, Math.min(p.x, global.innerWidth - w - 8));
    var y = Math.max(8, Math.min(p.y, global.innerHeight - hh - 8));
    this.launcher.style.position = 'fixed';
    this.launcher.style.left = x + 'px';
    this.launcher.style.top = y + 'px';
    this.launcher.style.right = 'auto';
    this.launcher.style.bottom = 'auto';
    this.el.setAttribute('data-floating', '');
    if (!silent) return;
  };

  /* ── 渲染 ─────────────────────────────────────────────────── */

  Widget.prototype._renderAll = function () {
    this._renderThread();
    this._renderHotBar();
    if (this.drawerOpen) this._renderDrawer();
  };

  Widget.prototype._renderThread = function () {
    var self = this;
    this.log.textContent = '';
    var msgs = this.thread.messages;
    if (!msgs.length) { this._renderEmpty(); return; }
    msgs.forEach(function (m, i) { self._renderMessage(m, i); });
    this._scroll();
  };

  Widget.prototype._renderEmpty = function () {
    var self = this;
    var box = h('div', { class: 'waa-empty' });

    // 还没配好模型时，第一件事是让用户能配上，而不是给他看问候语
    if (this.opts.setup === 'auto' && this._needsSetup()) {
      box.appendChild(h('div', { class: 'waa-setup-card' }, [
        h('p', { class: 'waa-setup-card__text', text: this.copy.setupEmpty }),
        h('button', {
          type: 'button', class: 'waa-btn waa-btn--primary', text: this.copy.setup,
          onclick: function () { self._openDrawer('setup'); }
        })
      ]));
      this.log.appendChild(box);
      return;
    }

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
    if (this._showHot('empty') && this.hot.length) {
      box.appendChild(this._hotBlock());
    }
    this.log.appendChild(box);
  };

  Widget.prototype._renderMessage = function (m, index) {
    var self = this;
    if (m.error) {
      var enode = h('div', { class: 'waa-msg waa-msg--error' }, [
        h('div', { class: 'waa-msg__rule' }),
        h('div', { class: 'waa-msg__body' }, [
          h('p', { class: 'waa-error__text', text: m.error }),
          h('button', {
            type: 'button', class: 'waa-retry', text: this.copy.retry,
            onclick: function () {
              self.thread.messages.splice(index, 1);
              self.store.save();
              self._renderThread();
              self._run();
            }
          })
        ])
      ]);
      this.log.appendChild(enode);
      return enode;
    }

    var node = h('div', { class: 'waa-msg waa-msg--' + m.role });
    if (m.role === 'assistant') node.appendChild(h('div', { class: 'waa-msg__rule' }));
    var body = h('div', { class: 'waa-msg__body' });
    if (m.role === 'assistant') body.innerHTML = renderMarkdown(m.content || '', this.copy);
    else body.textContent = m.content || '';
    node.appendChild(body);

    // 参考资料（RAG 命中）
    if (m.role === 'assistant' && m.references && m.references.length) {
      body.appendChild(this._refsBlock(m.references));
    }
    // 离线时本地作答的，标出来——别让访客把兜底文案当成模型回答
    if (m.local) node.appendChild(h('span', { class: 'waa-msg__tag', text: this.copy.offlineBadge }));
    if (m.stopped) node.classList.add('is-stopped');
    this.log.appendChild(node);
    return { node: node, body: body };
  };

  Widget.prototype._refsBlock = function (refs) {
    var list = h('ul', { class: 'waa-refs__list', hidden: true });
    refs.forEach(function (r) {
      var li = h('li', { class: 'waa-refs__item' });
      if (r.url) {
        li.appendChild(h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer', text: r.title || r.url }));
      } else {
        li.appendChild(h('span', { class: 'waa-refs__title', text: r.title || '参考资料' }));
      }
      if (r.snippet) li.appendChild(h('span', { class: 'waa-refs__snippet', text: r.snippet }));
      list.appendChild(li);
    });
    var toggle = h('button', {
      type: 'button', class: 'waa-refs__toggle',
      'aria-expanded': 'false',
      text: this.copy.refs + ' · ' + refs.length,
      onclick: function () {
        var open = list.hidden;
        list.hidden = !open;
        this.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
    });
    return h('div', { class: 'waa-refs' }, [toggle, list]);
  };

  Widget.prototype._appendStreaming = function () {
    var empty = this.log.querySelector('.waa-empty');
    if (empty) empty.remove();
    var node = h('div', { class: 'waa-msg waa-msg--assistant is-streaming' });
    node.appendChild(h('div', { class: 'waa-msg__rule' }));
    var body = h('div', { class: 'waa-msg__body' });
    node.appendChild(body);
    this.log.appendChild(node);
    this._scroll();
    return { node: node, body: body };
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

  /* ── 热词 ─────────────────────────────────────────────────── */

  Widget.prototype._showHot = function (where) {
    var p = this.opts.hotWordsPlacement;
    if (p === 'off' || !p) return false;
    if (p === 'both') return true;
    return p === where;
  };

  Widget.prototype._hotBlock = function () {
    var self = this;
    var list = h('div', { class: 'waa-hot__list' });
    this.hot.slice(0, 8).forEach(function (w) {
      list.appendChild(h('button', {
        type: 'button', class: 'waa-hot__item',
        onclick: function () { self.send(w.text); }
      }, [
        h('span', { text: w.text }),
        w.weight ? h('span', { class: 'waa-hot__n', text: String(w.weight) }) : null
      ]));
    });
    return h('div', { class: 'waa-hot' }, [
      h('span', { class: 'waa-hot__label', text: this.copy.hot }),
      list
    ]);
  };

  Widget.prototype._renderHotBar = function () {
    if (!this.hotBar) return;
    var show = this._showHot('composer') && this.hot.length &&
      (!this.input || this.input.value.trim() === '');
    this.hotBar.hidden = !show;
    if (!show) { this.hotBar.textContent = ''; return; }
    this.hotBar.textContent = '';
    this.hotBar.appendChild(this._hotBlock());
  };

  Widget.prototype.setHotWords = function (list) {
    this.hot = normalizeHot(list);
    this._renderHotBar();
    if (!this.thread.messages.length) this._renderThread();
    return this.hot;
  };

  Widget.prototype._loadHotWords = function () {
    var self = this;
    fetch(this.opts.hotWordsUrl).then(function (r) { return r.json(); }).then(function (data) {
      var items = Array.isArray(data) ? data : (data.items || data.words || data.hot || []);
      if (!items || !items.length) return;
      self.hot = normalizeHot(items);
      self._renderHotBar();
      if (!self.thread.messages.length) self._renderThread();
    }).catch(function () { /* 拉不到就用静态的，不打扰用户 */ });
  };

  function normalizeHot(list) {
    if (!list) return [];
    return (Array.isArray(list) ? list : []).map(function (x) {
      if (typeof x === 'string') return { text: x, weight: 0 };
      return {
        text: String(x.text || x.word || x.name || x.query || ''),
        weight: Number(x.weight || x.count || x.n || 0) || 0
      };
    }).filter(function (x) { return x.text; });
  }

  /* ── 历史抽屉 ─────────────────────────────────────────────── */

  Widget.prototype._toggleDrawer = function () {
    this.drawerOpen ? this._closeDrawer() : this._openDrawer('main');
  };

  Widget.prototype._openDrawer = function (view) {
    this.drawerView = view || 'main';
    this.drawerOpen = true;
    this._renderDrawer();
    this.drawer.hidden = false;
    this.el.classList.add('is-drawer');
    this.btnHistory.setAttribute('aria-expanded', 'true');
  };

  Widget.prototype._closeDrawer = function () {
    this.drawerOpen = false;
    this.drawer.hidden = true;
    this.el.classList.remove('is-drawer');
    this.btnHistory.setAttribute('aria-expanded', 'false');
  };

  Widget.prototype._renderDrawer = function () {
    this.drawer.textContent = '';
    if (this.drawerView === 'shortcuts') { this._renderShortcuts(); return; }
    if (this.drawerView === 'setup') { this._renderSetup(); return; }
    this._renderHistoryAndMemory();
  };

  /* ── 配置面板 ─────────────────────────────────────────────── */

  Widget.prototype._renderSetup = function () {
    var self = this;
    var en = this.opts.locale === 'en';
    var cur = this.getConfig();

    function field(label, input, hint) {
      return h('label', { class: 'waa-field' }, [
        h('span', { class: 'waa-field__label', text: label }),
        input,
        hint ? h('span', { class: 'waa-field__hint', text: hint }) : null
      ]);
    }

    var providerSel = h('select', { class: 'waa-input-box waa-input-box--select' });
    providerSel.appendChild(h('option', { value: '', text: this.copy.setupProviderCustom }));
    Object.keys(PROVIDERS).forEach(function (k) {
      providerSel.appendChild(h('option', { value: k, text: PROVIDERS[k].label + ' · ' + k }));
    });
    providerSel.value = cur.provider || '';

    var keyInput = h('input', {
      type: 'password', class: 'waa-input-box', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'sk-…', value: cur.apiKey || ''
    });
    var modelInput = h('input', {
      type: 'text', class: 'waa-input-box', autocomplete: 'off', spellcheck: 'false',
      placeholder: (PROVIDERS[cur.provider] || {}).model || '', value: cur.model || ''
    });
    var endpointInput = h('input', {
      type: 'text', class: 'waa-input-box', autocomplete: 'off', spellcheck: 'false',
      placeholder: (PROVIDERS[cur.provider] || {}).endpoint || '', value: cur.endpoint || ''
    });

    providerSel.addEventListener('change', function () {
      var p = PROVIDERS[providerSel.value];
      modelInput.placeholder = (p && p.model) || '';
      endpointInput.placeholder = (p && p.endpoint) || '';
    });

    var status = h('div', { class: 'waa-setup__status', hidden: true });

    function collect() {
      return {
        provider: providerSel.value,
        apiKey: keyInput.value.trim(),
        model: modelInput.value.trim(),
        endpoint: endpointInput.value.trim()
      };
    }

    function setStatus(text, kind) {
      status.textContent = text;
      status.hidden = false;
      status.setAttribute('data-kind', kind || '');
    }

    var testBtn = h('button', {
      type: 'button', class: 'waa-btn', text: this.copy.setupTest,
      onclick: function () {
        setStatus(self.copy.setupTesting, 'busy');
        testBtn.disabled = true;
        self._probe(collect()).then(function () {
          setStatus(self.copy.setupOk, 'ok');
        }, function (e) {
          setStatus(self.copy.setupFail + '：' + (e && e.message ? e.message : e), 'error');
        }).then(function () { testBtn.disabled = false; });
      }
    });

    var saveBtn = h('button', {
      type: 'button', class: 'waa-btn waa-btn--primary', text: this.copy.setupSave,
      onclick: function () {
        self.setConfig(collect());
        setStatus(self.copy.setupSaved, 'ok');
        self._renderThread();
      }
    });

    var resetBtn = h('button', {
      type: 'button', class: 'waa-btn', text: this.copy.setupReset,
      onclick: function () {
        self.resetConfig();
        setStatus(self.copy.setupCleared, '');
        self._renderSetup();
        self._renderThread();
      }
    });

    this.drawer.appendChild(h('div', { class: 'waa-drawer__sec' }, [
      h('div', { class: 'waa-drawer__head' }, [
        h('span', { class: 'waa-drawer__title', text: this.copy.setup }),
        h('button', {
          type: 'button', class: 'waa-drawer__act', text: this.copy.back,
          onclick: function () { self._openDrawer('main'); }
        })
      ]),
      h('div', { class: 'waa-form' }, [
        field(this.copy.setupProvider, providerSel),
        field(this.copy.setupKey, keyInput),
        field(this.copy.setupModel, modelInput, en ? this.copy.setupModelHint : this.copy.setupModelHint),
        field(this.copy.setupEndpoint, endpointInput, this.copy.setupEndpointHint)
      ]),
      status,
      h('div', { class: 'waa-setup__actions' }, [testBtn, saveBtn, resetBtn]),
      h('p', { class: 'waa-drawer__note', text: this.opts.setupNote || this.copy.setupWarn })
    ]));
  };

  Widget.prototype._renderShortcuts = function () {
    var self = this;
    var en = this.opts.locale === 'en';

    function keyTable(rows) {
      var dl = h('dl', { class: 'waa-keys' });
      rows.forEach(function (r) {
        var combo = h('dt', { class: 'waa-keys__combo' });
        fmtCombo(r.combo).forEach(function (k) { combo.appendChild(h('kbd', { text: k })); });
        dl.appendChild(combo);
        dl.appendChild(h('dd', { class: 'waa-keys__label', text: en ? r.en : r.zh }));
      });
      return dl;
    }

    this.drawer.appendChild(h('div', { class: 'waa-drawer__sec' }, [
      h('div', { class: 'waa-drawer__head' }, [
        h('span', { class: 'waa-drawer__title', text: this.copy.shortcuts }),
        h('button', {
          type: 'button', class: 'waa-drawer__act', text: this.copy.back,
          onclick: function () { self._openDrawer('main'); }
        })
      ]),
      keyTable(this._shortcutList()),
      h('div', { class: 'waa-keys__group', text: this.copy.nativeGroup }),
      keyTable(NATIVE_KEYS),
      h('p', { class: 'waa-drawer__note', text: this.copy.shortcutsNote })
    ]));
  };

  Widget.prototype._renderHistoryAndMemory = function () {
    var self = this;
    this.drawer.textContent = '';

    // 历史
    this._sortThreads();
    var threads = this.store.state.threads;
    var list = h('ul', { class: 'waa-threads' });
    threads.forEach(function (t) {
      var active = t.id === self.thread.id;
      list.appendChild(h('li', { class: 'waa-thread' + (active ? ' is-active' : '') }, [
        h('button', {
          type: 'button', class: 'waa-thread__open',
          'aria-current': active ? 'true' : null,
          onclick: function () { self.openThread(t.id); }
        }, [
          h('span', { class: 'waa-thread__title', text: self._titleOf(t) }),
          h('span', { class: 'waa-thread__meta', text: relTime(t.updatedAt, self.copy) })
        ]),
        h('button', {
          type: 'button', class: 'waa-thread__del',
          'aria-label': self.copy.delete, title: self.copy.delete,
          onclick: function (e) {
            e.stopPropagation();
            self.deleteThread(t.id);
            if (self.drawerOpen) self._renderDrawer();
          }
        }, [icon(ICONS.trash, 13)])
      ]));
    });
    if (!threads.length) list.appendChild(h('li', { class: 'waa-threads__none', text: '—' }));

    this.drawer.appendChild(h('div', { class: 'waa-drawer__sec' }, [
      h('div', { class: 'waa-drawer__head' }, [
        h('span', { class: 'waa-drawer__title', text: this.copy.history }),
        h('button', {
          type: 'button', class: 'waa-drawer__act', text: this.copy.clearAll,
          onclick: function () {
            if (global.confirm && !global.confirm(self.copy.clearAll + '？')) return;
            self.clearAll();
            self._closeDrawer();
          }
        })
      ]),
      list
    ]));

    // 记忆
    if (this.opts.memory) {
      var keys = Object.keys(this.memory);
      var body;
      if (!keys.length) {
        body = h('div', { class: 'waa-mem__empty', text: this.copy.memoryEmpty });
      } else {
        body = h('dl', { class: 'waa-mem' });
        keys.forEach(function (k) {
          body.appendChild(h('dt', { text: k }));
          body.appendChild(h('dd', { text: String(self.memory[k]) }));
        });
      }
      this.drawer.appendChild(h('div', { class: 'waa-drawer__sec' }, [
        h('div', { class: 'waa-drawer__head' }, [
          h('span', { class: 'waa-drawer__title', text: this.copy.memory }),
          keys.length ? h('button', {
            type: 'button', class: 'waa-drawer__act', text: this.copy.memoryClear,
            onclick: function () { self.forget(); self._renderDrawer(); }
          }) : null
        ]),
        body
      ]));
    }
  };

  function relTime(ts, copy) {
    if (!ts) return '';
    var d = Date.now() - ts;
    if (d < 60000) return copy.justNow;
    if (d < 3600000) return Math.floor(d / 60000) + 'm';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h';
    if (d < 604800000) return Math.floor(d / 86400000) + 'd';
    var dt = new Date(ts);
    return (dt.getMonth() + 1) + '/' + dt.getDate();
  }

  /* ── 会话与记忆的落地 ─────────────────────────────────────── */

  Widget.prototype._commit = function () {
    this.thread.updatedAt = Date.now();
    this._prune();
    this.store.save();
  };

  /* ── 发送与流式 ───────────────────────────────────────────── */

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
    this.thread.messages.push({ role: 'user', content: v });
    this._renderThread();
    this._commit();
    if (this._isOffline() && this.opts.offline.enabled) { this._answerOffline(v); return; }
    this._run();
  };

  /* ── 离线 ─────────────────────────────────────────────────── */

  Widget.prototype._isOffline = function () {
    if (!this.opts.offline.enabled) return false;
    // navigator.onLine 只反映"网卡有没有连上"，代理挂了它照样是 true。
    // 所以它只能用来提前拦截，不能替代请求失败的处理。
    return !!(global.navigator && global.navigator.onLine === false);
  };

  Widget.prototype._matchOffline = function (text) {
    var list = this.opts.offline.answers || [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || !a.reply) continue;
      if (a.match instanceof RegExp) {
        if (a.match.test(text)) return a;
      } else if (typeof a.match === 'string' && a.match &&
                 text.toLowerCase().indexOf(a.match.toLowerCase()) !== -1) {
        return a;
      }
    }
    return null;
  };

  /** 离线时：能本地答就答；答不了就给一句人话，并记住这条问题等联网补发 */
  Widget.prototype._answerOffline = function (question) {
    var off = this.opts.offline;
    var hit = this._matchOffline(question);
    if (hit) {
      this.thread.messages.push({ role: 'assistant', content: hit.reply, local: true });
    } else {
      if (!off.resend) {
        this.thread.messages.push({
          role: 'assistant', local: true,
          content: off.fallback || this.copy.offlineFallbackNoQueue
        });
      } else {
        // 上一条还没补发的问题作废：它的占位消息撤掉，问题本身留在对话里
        this._dropPending();
        this.thread.messages.push({
          role: 'assistant', local: true, pending: true,
          content: off.fallback || this.copy.offlineFallback
        });
        this.store.state.pending = {
          content: question,
          threadId: this.thread.id,
          at: Date.now()
        };
        this.store.save();
      }
    }
    this._renderThread();
    this._commit();
    this._syncNetState();
  };

  /** 撤掉待补发标记和它的占位消息（不动用户那条提问） */
  Widget.prototype._dropPending = function () {
    var s = this.store.state;
    if (!s.pending) return;
    s.pending = null;
    this.store.save();
    for (var i = this.thread.messages.length - 1; i >= 0; i--) {
      if (this.thread.messages[i].pending) { this.thread.messages.splice(i, 1); break; }
    }
  };

  Widget.prototype.hasPendingQuestion = function () {
    return !!this.store.state.pending;
  };

  /** 恢复联网后补发：把占位消息截掉，末尾回到那条提问，正常走一遍请求 */
  Widget.prototype._resendPending = function () {
    var s = this.store.state;
    var p = s.pending;
    if (!p || this.busy || this._isOffline()) return;
    s.pending = null;
    this.store.save();

    if (p.threadId && p.threadId !== this.thread.id && !this.openThread(p.threadId)) return;

    var msgs = this.thread.messages;
    var cut = -1;
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].pending) { cut = i; break; }
    }
    // 占位消息没了（用户删了会话或手动重试过）就别乱补
    if (cut === -1) { this._renderThread(); return; }
    msgs.length = cut;
    this._renderThread();
    this._commit();

    this._setHeadMeta(this.copy.resending, 'busy');
    this._run();
  };

  Widget.prototype._syncNetState = function () {
    if (this.busy) return;
    if (this._isOffline()) this._setHeadMeta(this.copy.offlineLabel, 'error');
    else this._setHeadMeta(this.copy.online);
  };

  Widget.prototype._bindNetwork = function () {
    var self = this;
    this._onOnline = function () {
      self._syncNetState();
      if (self.hasPendingQuestion()) self._resendPending();
    };
    this._onOffline = function () { self._syncNetState(); };
    global.addEventListener('online', this._onOnline);
    global.addEventListener('offline', this._onOffline);
    // 挂载时如果本来就是断网状态，别显示"在线"骗人
    if (this._isOffline()) this._setHeadMeta(this.copy.offlineLabel, 'error');
  };

  Widget.prototype._submit = function () { this.send(); };

  Widget.prototype._run = async function () {
    var self = this;
    var history = this.thread.messages
      .filter(function (m) { return !m.error; })
      .map(function (m) { return { role: m.role, content: m.content }; });

    var ctx = {
      messages: this._memoryMessages().concat(history),
      history: history,
      memory: this.getMemory(),
      knowledge: this.opts.knowledge || null,
      config: this.opts,
      signal: null,
      onDelta: null,
      onReferences: null
    };

    if (typeof this.opts.onBeforeSend === 'function') {
      var proceed;
      try { proceed = await this.opts.onBeforeSend({ messages: ctx.messages, config: this.opts, memory: ctx.memory }); }
      catch (e) { proceed = true; }
      if (proceed === false) return;
    }

    this.busy = true;
    this.abort = new AbortController();
    ctx.signal = this.abort.signal;
    this._setHeadMeta(this.copy.thinking, 'busy');
    this.sendBtn.classList.add('is-stop');
    this.sendBtn.setAttribute('aria-label', this.copy.stop);

    var target = this._appendStreaming();
    var acc = '';
    var refs = [];
    ctx.onDelta = function (_delta, full) {
      acc = full != null ? full : acc + _delta;
      target.body.innerHTML = renderMarkdown(acc, self.copy);
      self._scroll();
    };
    ctx.onReferences = function (list) {
      if (list && list.length) refs = list;
    };

    try {
      // 前端检索钩子：适合"知识库就在同源后端"的场景，省一次协议往返
      if (typeof this.opts.retrieve === 'function' && !refs.length) {
        var lastUser = history.filter(function (m) { return m.role === 'user'; }).slice(-1)[0];
        if (lastUser) {
          try {
            var got = await this.opts.retrieve(lastUser.content, { messages: history });
            if (Array.isArray(got) && got.length) { refs = got; ctx.onReferences(got); }
          } catch (e) { /* 检索失败不该拦住对话 */ }
        }
      }

      var transport = this._resolveTransport();
      var out = await transport(ctx);
      var finalText = typeof out === 'string' ? out : (out && out.text) || '';
      if (out && out.references && out.references.length) refs = out.references;

      if (!acc) acc = finalText;
      target.node.classList.remove('is-streaming');
      target.node.remove();

      var msg = { role: 'assistant', content: acc };
      if (refs.length) msg.references = refs;
      this.thread.messages.push(msg);
      this._renderThread();
      this._commit();
      this._setHeadMeta(this.copy.online);

      if (typeof this.opts.onAfterSend === 'function') {
        try {
          this.opts.onAfterSend({
            messages: this.thread.messages.slice(), reply: acc,
            references: refs, config: this.opts, threadId: this.thread.id
          });
        } catch (e) { /* 埋点失败不能影响体验 */ }
      }
    } catch (err) {
      target.node.remove();
      if (err && err.name === 'AbortError') {
        if (acc) {
          var stopped = { role: 'assistant', content: acc, stopped: true };
          if (refs.length) stopped.references = refs;
          this.thread.messages.push(stopped);
          this._renderThread();
          this._commit();
        }
        this._setHeadMeta(this.copy.online);
      } else {
        var msg2 = err && err.message ? err.message : '请求失败';
        if (/Failed to fetch|NetworkError|Load failed/i.test(msg2)) {
          msg2 = this.opts.locale === 'en' ? 'Network unreachable. Check the endpoint.' : '连不上服务，检查接口地址或网络。';
        }
        this.thread.messages.push({ role: 'assistant', content: '', error: msg2 });
        this._renderThread();
        this._commit();
        this._setHeadMeta(this.copy.offline, 'error');
        if (typeof this.opts.onError === 'function') {
          try { this.opts.onError(err); } catch (e) { /* 忽略 */ }
        }
      }
    } finally {
      this.busy = false;
      this.abort = null;
      this.sendBtn.classList.remove('is-stop');
      this.sendBtn.setAttribute('aria-label', this.copy.send);
      // 待补发的那条已经自己跑完，不用再排队
    }
  };

  /* ── 开关 ─────────────────────────────────────────────────── */

  Widget.prototype.open = function () {
    this.openState = true;
    this.panel.hidden = false;
    this.el.classList.add('is-open');
    this.launcher.setAttribute('aria-expanded', 'true');
    this.launcher.setAttribute('aria-label', this.copy.close);
    var badge = this.launcher.querySelector('.waa-launcher__badge');
    if (badge) badge.hidden = true;
    var self = this;
    requestAnimationFrame(function () { self.input.focus(); self._scroll(); });
  };

  Widget.prototype.close = function () {
    this.openState = false;
    this.panel.hidden = true;
    this.el.classList.remove('is-open');
    this.launcher.setAttribute('aria-expanded', 'false');
    this.launcher.setAttribute('aria-label', this.copy.open);
    this._closeDrawer();
    if (this.busy && this.abort) this.abort.abort();
  };

  Widget.prototype.toggle = function () { this.openState ? this.close() : this.open(); };

  Widget.prototype.reset = function () { return this.newThread(); };

  Widget.prototype.destroy = function () {
    document.removeEventListener('keydown', this._onKeydown);
    document.removeEventListener('pointerdown', this._onDocPointerDown, true);
    global.removeEventListener('online', this._onOnline);
    global.removeEventListener('offline', this._onOffline);
    if (this._hotTimer) clearInterval(this._hotTimer);
    if (this._teardownDrag) this._teardownDrag();
    if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
    // 从 instances 里摘掉：SPA 里反复 mount/destroy（比如切换主题）会一直往数组里堆，
    // 而且 instances[0] 会一直是那个早就销毁的实例，排查时非常容易被带偏。
    var i = instances.indexOf(this);
    if (i !== -1) instances.splice(i, 1);
  };

  Widget.prototype.setExtraInfo = function (info) {
    this.opts.extraInfo = info;
  };

  /* ── 复制代码块（事件委托，避免每个块都挂监听） ───────────── */

  /**
   * 写剪贴板。navigator.clipboard 只在安全上下文（https / localhost）可用，
   * 站点用 http 内网域名部署时它会直接不存在——那种情况下退回到
   * 临时 textarea + execCommand，不然按钮点了没反应，用户只会以为坏了。
   */
  function writeClipboard(text) {
    return new Promise(function (resolve) {
      if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { resolve(true); }, function () { resolve(legacyCopy(text)); });
        return;
      }
      resolve(legacyCopy(text));
    });
  }

  function legacyCopy(text) {
    var ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand && document.execCommand('copy');
      return !!ok;
    } catch (e) {
      return false;
    } finally {
      if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
    }
  }

  function onCopyClick(e) {
    var btn = e.target && e.target.closest && e.target.closest('.waa-code__copy');
    if (!btn) return;
    var code = btn.getAttribute('data-copy') || '';
    var old = btn.textContent;
    var okText = btn.getAttribute('data-copied') || '已复制';
    var failText = btn.getAttribute('data-fail') || '复制失败';
    writeClipboard(code).then(function (ok) {
      btn.textContent = ok ? okText : failText;
      setTimeout(function () { btn.textContent = old; }, 1200);
    });
  }

  /* ────────────────────────────────────────────────────────────
   * 对外接口
   * ──────────────────────────────────────────────────────────── */

  var instances = [];

  function mount(options) {
    var w = new Widget(options || {});
    if (w.root && w.root.addEventListener) w.root.addEventListener('click', onCopyClick);
    instances.push(w);
    return w;
  }

  function defineTransport(name, fn) { transports[name] = fn; }

  function autoMount() {
    var scripts = document.querySelectorAll('script[data-waa]');
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      if (s.__waaMounted) continue;
      s.__waaMounted = true;
      var d = s.dataset;
      var w = mount({
        scriptEl: s,
        provider: d.provider || '',
        name: d.name || DEFAULTS.name,
        locale: d.locale || DEFAULTS.locale,
        transport: d.transport || DEFAULTS.transport,
        endpoint: d.endpoint || '',
        model: d.model || '',
        appId: d.appId || '',
        cssUrl: d.cssUrl || '',
        greeting: d.greeting || '',
        suggestions: splitList(d.suggestions),
        hotWords: splitList(d.hotWords),
        hotWordsUrl: d.hotWordsUrl || '',
        hotWordsPlacement: d.hotWordsPlacement || DEFAULTS.hotWordsPlacement,
        theme: d.theme || DEFAULTS.theme,
        position: d.position || DEFAULTS.position,
        draggable: d.draggable !== 'false',
        autoOpen: d.autoOpen === 'true',
        closeOnOutsideClick: d.closeOnOutsideClick !== 'false',
        shortcuts: d.shortcuts !== 'false',
        offline: d.offline === 'false' ? { enabled: false } : null,
        setup: d.setup === 'auto' ? 'auto' : (d.setup === 'true'),
        outsideIgnore: d.outsideIgnore || null,
        storage: d.storage || (d.persist === 'false' ? 'none' : (d.persist === 'true' ? 'local' : DEFAULTS.storage)),
        history: d.history !== 'false',
        memory: d.memory !== 'false',
        accent: d.accent || '',
        radius: d.radius || '',
        zIndex: Number(d.zIndex) || DEFAULTS.zIndex
      });
      s.__waaInstance = w;
    }
  }

  function splitList(v) {
    if (!v) return null;
    return v.split('|').map(function (x) { return x.trim(); }).filter(Boolean);
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
    providers: PROVIDERS,
    shortcuts: SHORTCUTS,
    instances: instances
  };
})(window);
