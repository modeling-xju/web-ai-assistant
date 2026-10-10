/*!
 * web-ai-assistant · 网站内嵌 AI 助手挂件
 * 零依赖 · Shadow DOM 样式隔离 · SSE 流式 · 后端 adapter 可替换
 *
 * 用法见 assets/embed-selfhosted.html 与 references/self-hosted-widget.md
 */
(function (global) {
  'use strict';

  var VERSION = '2.0.0';
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
    trash: ['M4 7h15', 'M9.5 7V5h5v2', 'M6.5 7l.9 12.5h9.2L17.5 7']
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
  function renderMarkdown(src) {
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
    return { threads: [], activeId: null, memory: {}, ui: {} };
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
    var raw = applyProvider(Object.assign({}, options || {}));
    this.opts = Object.assign({}, DEFAULTS, raw);
    // 兼容 v1 的 persist:false
    if (this.opts.persist === false) this.opts.storage = 'none';
    if (this.opts.persist === true && this.opts.storage === 'session') this.opts.storage = 'local';
    this.scriptEl = this.opts.scriptEl || null;
    this.copy = COPY[this.opts.locale] || COPY.zh;

    this.store = new Store(this.opts);
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
        this.btnNew, this.btnHistory, this.btnClose
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
    return SHORTCUTS.map(function (s) {
      return {
        id: s.id,
        combo: over[s.id] === false ? null : (over[s.id] || s.combo),
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
    if (m.role === 'assistant') body.innerHTML = renderMarkdown(m.content || '');
    else body.textContent = m.content || '';
    node.appendChild(body);

    // 参考资料（RAG 命中）
    if (m.role === 'assistant' && m.references && m.references.length) {
      body.appendChild(this._refsBlock(m.references));
    }
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
    this._renderHistoryAndMemory();
  };

  Widget.prototype._renderShortcuts = function () {
    var self = this;
    var en = this.opts.locale === 'en';
    var rows = h('dl', { class: 'waa-keys' });
    this._shortcutList().forEach(function (s) {
      var combo = h('dt', { class: 'waa-keys__combo' });
      fmtCombo(s.combo).forEach(function (k) { combo.appendChild(h('kbd', { text: k })); });
      rows.appendChild(combo);
      rows.appendChild(h('dd', { class: 'waa-keys__label', text: en ? s.en : s.zh }));
    });

    this.drawer.appendChild(h('div', { class: 'waa-drawer__sec' }, [
      h('div', { class: 'waa-drawer__head' }, [
        h('span', { class: 'waa-drawer__title', text: this.copy.shortcuts }),
        h('button', {
          type: 'button', class: 'waa-drawer__act', text: this.copy.back,
          onclick: function () { self._openDrawer('main'); }
        })
      ]),
      rows,
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
    this._run();
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
      target.body.innerHTML = renderMarkdown(acc);
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
    if (this._hotTimer) clearInterval(this._hotTimer);
    if (this._teardownDrag) this._teardownDrag();
    if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
  };

  Widget.prototype.setExtraInfo = function (info) {
    this.opts.extraInfo = info;
  };

  /* ── 复制代码块（事件委托，避免每个块都挂监听） ───────────── */

  function onCopyClick(e) {
    var btn = e.target && e.target.closest && e.target.closest('.waa-code__copy');
    if (!btn) return;
    var code = btn.getAttribute('data-copy') || '';
    var done = function () {
      var old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = old; }, 1200);
    };
    if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done, function () { /* 非安全上下文下静默失败 */ });
    }
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
