#!/usr/bin/env node
/**
 * verify-embed.mjs —— 内嵌 AI 助手的接入配置静态校验器
 *
 *   bun scripts/verify-embed.mjs <文件或目录> [...]        # 人类可读
 *   bun scripts/verify-embed.mjs <路径> --json            # 机器可读
 *   bun scripts/verify-embed.mjs . --min-severity warn    # 只报 warn 及以上
 *
 * 退出码：有 error 时 1，否则 0。可以直接当交付前的闸门用。
 *
 * 它查的是"配置写对没有"这一类问题——占位符没换、域名填成相对路径、init 时序错、
 * key 泄漏到前端、样式表漏拷。这些都是静态可判定的，且恰好是真实部署里最常翻车的几种。
 * 它不查"跑起来对不对"——那个要真的打开页面点一遍。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, dirname, resolve, relative } from 'node:path';

const SEV = { error: 3, warn: 2, info: 1 };
const SEV_LABEL = { error: '错误', warn: '警告', info: '提示' };
const MARK = { error: '✗', warn: '⚠', info: '·' };

const SCAN_EXT = new Set([
  '.html', '.htm', '.vue', '.jsx', '.tsx', '.js', '.mjs', '.cjs', '.ts',
  '.php', '.jsp', '.asp', '.aspx', '.ejs', '.hbs', '.njk', '.twig', '.svelte', '.astro'
]);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', '.output', 'dist', 'build', '__pycache__', 'venv', '.venv', 'coverage']);

/* ── 参数 ─────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const jsonOut = argv.includes('--json');
const minSevIdx = argv.indexOf('--min-severity');
const minSeverity = minSevIdx !== -1 ? argv[minSevIdx + 1] : 'info';
const minSev = SEV[minSeverity] || 1;
const targets = argv.filter((a, i) => !a.startsWith('--') && (minSevIdx === -1 || i !== minSevIdx + 1));

if (!targets.length) {
  console.error('用法：verify-embed.mjs <文件或目录> [...] [--json] [--min-severity error|warn|info]');
  process.exit(2);
}

/* ── 收集文件 ─────────────────────────────────────────────── */

function walk(p, out = []) {
  let st;
  try { st = statSync(p); } catch { return out; }
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) {
      if (SKIP_DIRS.has(name)) continue;
      walk(join(p, name), out);
    }
  } else if (SCAN_EXT.has(extname(p).toLowerCase())) {
    out.push(p);
  }
  return out;
}

const files = [...new Set(targets.flatMap((t) => walk(resolve(t))))];

/* ── 把注释挖空（保留换行，这样行号仍然准） ──────────────── */

function blankOut(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)          // HTML 注释
    .replace(/\/\*[\s\S]*?\*\//g, blank)          // 块注释
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length)); // 行注释（放过 https://）
}

function lineAt(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

/* ── 规则 ─────────────────────────────────────────────────── */

const PLACEHOLDER = /YOUR_|你的|集成\s?ID|INTEGRATE_ID|REQUEST_DOMAIN|xxxxxxxx|xxxxx|xxx\.appflow|占位|TODO|REPLACE_ME|示例域名|<\/?请/i;

function checkFile(file) {
  const raw = readFileSync(file, 'utf8');
  const src = blankOut(raw);
  const issues = [];
  const push = (severity, code, index, message, fix) =>
    issues.push({ file, line: lineAt(src, index), severity, code, message, fix });

  const isMarkup = /\.(html?|vue|php|jsp|asp|aspx|ejs|hbs|njk|twig|svelte|astro)$/i.test(file);

  /* 1. AppFlow 集成配置 */
  const integ = /integrateId\s*:\s*(['"`])([^'"`]*)\1/g;
  let m;
  let sawIntegrate = false;
  while ((m = integ.exec(src))) {
    sawIntegrate = true;
    if (!m[2].trim() || PLACEHOLDER.test(m[2])) {
      push('error', 'E-INTEGRATE-PLACEHOLDER', m.index,
        `integrateId 还是占位符：${JSON.stringify(m[2])}`,
        '去 AppFlow → AI 助手 → Web 集成 → 页面集成详情，复制真实的集成 ID');
    }
  }

  const dom = /requestDomain\s*:\s*(['"`])([^'"`]*)\1/g;
  while ((m = dom.exec(src))) {
    const v = m[2].trim();
    if (!v || PLACEHOLDER.test(v)) {
      push('error', 'E-DOMAIN-PLACEHOLDER', m.index,
        `requestDomain 还是占位符：${JSON.stringify(v)}`,
        '必须填你自己集成页面里的域名，形如 https://xxx.appflow.aliyunnest.com');
    } else if (!/^https?:\/\//i.test(v)) {
      push('error', 'E-DOMAIN-RELATIVE', m.index,
        `requestDomain 不是绝对地址：${JSON.stringify(v)}`,
        '这是 "Failed to stream content" 的典型成因。改成完整域名 https://…');
    } else if (/^http:\/\//i.test(v)) {
      push('warn', 'W-DOMAIN-INSECURE', m.index,
        `requestDomain 用的是 http：${v}`,
        '站点如果是 https，混合内容会被浏览器拦掉。用 https');
    } else if (!/appflow\.aliyunnest\.com/i.test(v)) {
      push('warn', 'W-DOMAIN-FOREIGN', m.index,
        `requestDomain 不像 AppFlow 域名：${v}`,
        '确认这个域名来自你自己的集成页面，而不是别处抄来的示例');
    }
  }

  /* 2. init 时序 —— defer + 内联 init 是必炸组合 */
  const scripts = [];
  if (isMarkup) {
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let s;
    while ((s = re.exec(src))) {
      scripts.push({
        attrs: s[1],
        body: s[2],
        index: s.index,
        defer: /\bdefer\b/i.test(s[1]),
        src: (/src\s*=\s*(['"])([^'"]*)\1/i.exec(s[1]) || [])[2] || ''
      });
    }
  }

  const sdkScript = scripts.find((s) => /AppflowChatSDK\.js/i.test(s.src));
  const initCalls = [];
  if (isMarkup) {
    scripts.filter((s) => !s.src && /APPFLOW_CHAT_SDK\s*\.\s*init\s*\(/.test(s.body))
      .forEach((s) => initCalls.push({ index: s.index + s.body.indexOf('.init'), wrapped: /addEventListener\s*\(\s*['"]load|DOMContentLoaded|readyState|onload/i.test(s.body) }));
  } else if (/APPFLOW_CHAT_SDK\s*\.\s*init\s*\(/.test(src)) {
    const i = src.indexOf('.init');
    initCalls.push({ index: i, wrapped: /addEventListener\s*\(\s*['"]load|DOMContentLoaded|readyState|onload/i.test(src) });
  }

  if (sawIntegrate && !sdkScript && isMarkup) {
    push('error', 'E-SDK-MISSING', src.indexOf('integrateId'),
      '调用 init 但页面里没有引入 AppflowChatSDK.js',
      '加上 <script src="https://o.alicdn.com/appflow/chatbot/v1/AppflowChatSDK.js" defer></script>');
  }

  initCalls.forEach((c) => {
    if (sdkScript && sdkScript.defer && c.index > sdkScript.index && !c.wrapped) {
      push('error', 'E-INIT-ORDER', c.index,
        'init 在内联脚本里直接调用，但 SDK 是 defer 加载的 —— 会报 APPFLOW_CHAT_SDK is undefined',
        '把 init 包进 window.addEventListener(\'load\', …)，或用 assets/appflow-snippet.html 的写法');
    }
  });

  if (initCalls.length > 1) {
    push('warn', 'W-INIT-TWICE', initCalls[1].index,
      `同一个文件里 init 了 ${initCalls.length} 次`,
      'SPA 里会挂出多个挂件。放到应用入口挂一次，或用模块级 flag 守住');
  }

  if (!isMarkup && initCalls.length && /\.(vue|jsx|tsx|svelte)$/i.test(file)) {
    const guarded = /\b(mounted|initialized|inited|didInit|singleton)\b/i.test(src);
    if (!guarded) {
      push('warn', 'W-COMPONENT-INIT', initCalls[0].index,
        '像是写在组件里的 init，没有看到只执行一次的守卫',
        '路由来回会反复 init。移到应用入口，或用模块级 flag');
    }
  }

  /* 3. 密钥泄漏 */
  const KEY_PATTERNS = [
    [/\bsk-[A-Za-z0-9_-]{16,}/g, 'E-KEY-OPENAI', 'OpenAI 风格的 API Key'],
    [/\bBearer\s+sk-[A-Za-z0-9_-]{16,}/g, 'E-KEY-BEARER', 'Bearer + API Key'],
    [/(DASHSCOPE_API_KEY|API_KEY|APIKEY|SECRET_KEY)\s*[:=]\s*(['"`])([A-Za-z0-9_\-]{16,})\2/gi, 'E-KEY-ASSIGN', '硬编码的密钥常量'],
    [/\bdashscope\.aliyuncs\.com[^\n]*[?&]api[_-]?key=[A-Za-z0-9]{16,}/gi, 'E-KEY-QUERY', 'URL 里带明文 key']
  ];
  for (const [re, code, label] of KEY_PATTERNS) {
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      push('error', code, m.index,
        `${label}出现在前端代码里：${m[0].slice(0, 40)}…`,
        '前端是公开的，写进去等于公开。把 key 放到后端，前端请求你自己的接口');
    }
  }

  /* 4. 自建挂件：样式表是否跟着 */
  if (/data-waa\b/.test(src) || /\bWebAIAssistant\s*\.\s*mount\s*\(/.test(src)) {
    const waaTags = (src.match(/data-waa\b/g) || []).length;
    if (waaTags > 1) {
      push('warn', 'W-WAA-TWICE', src.indexOf('data-waa'),
        `页面上有 ${waaTags} 个 data-waa 挂载点`,
        '一个页面挂一个就够了，多了会有两个图标');
    }
    const jsRef = /ai-assistant\.js/i.test(src) || /WebAIAssistant/.test(src);
    if (jsRef) {
      const explicit = /(cssUrl|ai-assistant\.css)/i.test(src);
      const guess = ['ai-assistant.css'];
      const here = dirname(resolve(file));
      const found = explicit || guess.some((g) => existsSync(join(here, g)));
      if (!found) {
        push('error', 'E-WAA-CSS-MISSING', src.indexOf('ai-assistant') >= 0 ? src.indexOf('ai-assistant') : 0,
          '引用了挂件 JS，但同目录下找不到 ai-assistant.css',
          '两个文件必须放同一目录（JS 按自己的 src 找同名 css）。缺了会渲染成没样式的裸 HTML');
      }
    }
  }

  /* 5. 上下文：值不值得提醒 */
  if ((sawIntegrate || /data-waa\b/.test(src)) && !/setExtraInfo|extraInfo/i.test(src)) {
    push('info', 'I-NO-CONTEXT', sawIntegrate ? src.indexOf('integrateId') : src.indexOf('data-waa'),
      '没有传业务上下文（setExtraInfo / extraInfo）',
      '把当前页面、当前商品 ID 传进去，助手才答得具体。这是成本最低、效果最明显的一步');
  }

  /* 6. z-index 明显偏低 */
  const z = /zIndex\s*:\s*(\d+)|data-z-index\s*=\s*(['"])(\d+)\2/g;
  while ((m = z.exec(src))) {
    const v = Number(m[1] || m[3]);
    if (v && v < 1000) {
      push('warn', 'W-ZINDEX-LOW', m.index,
        `z-index = ${v}，很可能被站点的导航栏或弹窗盖住`,
        '挂件建议用 2147483000 这一档，并在真实页面上确认没有被遮');
    }
  }

  return issues;
}

/* ── 跑 ───────────────────────────────────────────────────── */

const all = [];
for (const f of files) {
  try { all.push(...checkFile(f)); }
  catch (e) { all.push({ file: f, line: 0, severity: 'error', code: 'E-READ', message: String(e.message), fix: '' }); }
}

all.sort((a, b) => SEV[b.severity] - SEV[a.severity] || a.file.localeCompare(b.file) || a.line - b.line);
const shown = all.filter((i) => SEV[i.severity] >= minSev);
const counts = { error: 0, warn: 0, info: 0 };
all.forEach((i) => counts[i.severity]++);

if (jsonOut) {
  console.log(JSON.stringify({
    scanned: files.map((f) => relative(process.cwd(), f)),
    counts,
    ok: counts.error === 0,
    issues: shown
  }, null, 2));
} else {
  console.log(`\nweb-ai-assistant · 接入校验   扫描 ${files.length} 个文件\n`);
  for (const i of shown) {
    const loc = `${relative(process.cwd(), i.file)}${i.line ? ':' + i.line : ''}`;
    console.log(`${MARK[i.severity]} ${loc}  [${i.code}] ${i.message}`);
    if (i.fix) console.log(`    → ${i.fix}`);
  }
  if (!shown.length) console.log('✓ 没有发现配置问题');
  console.log(`\n${counts.error} 个错误 · ${counts.warn} 个警告 · ${counts.info} 个提示`);
  if (counts.error === 0) console.log('静态检查通过。还需要真的打开页面点一遍（见 SKILL.md 验证清单）。\n');
}

process.exit(counts.error > 0 ? 1 : 0);
