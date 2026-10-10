# 自建挂件（路径 B）

没有 AppFlow、要私有部署、要接自研模型、或者要本地跑通验证时走这条。

## 为什么是"单文件 JS + Shadow DOM + 可替换 transport"这个形状

内嵌挂件只有三个真正的技术难点，这个形状是冲着它们去的：

1. **样式互相污染。** 挂件要塞进**别人的**页面，而你不可能知道那个页面写了什么全局样式（`* { box-sizing }`、`div { margin }`、`button { font-family: cursive }` 都很常见）。Shadow DOM 是目前唯一能双向隔离的原生方案——外面的选择器进不来，里面的出不去。用普通 `<div class="ai-chat">` 的话，迟早会在某个页面上被弄歪，而且你很难复现。
2. **模型供应商会变。** 今天百炼，明天换个网关，后天自研。所以界面**只认一个契约**，不认任何具体厂商的请求格式。
3. **密钥不能进前端。** 静态页面是公开的，写进去的 key 等于公开。所以前端打自己的接口，key 在后端。

## 传输契约

界面只依赖这一个函数签名（`assets/widget/ai-assistant.js` 里 `transports` 对象）：

```js
async function transport({ messages, config, signal, onDelta, onReferences, memory, knowledge }) {
  // messages:       [{ role: 'user' | 'assistant', content: string }]
  // config:         挂件的全部配置（endpoint / model / apiKey / headers / …）
  // signal:         AbortSignal，用户点"停止"时会 abort，你要把它透传给 fetch
  // memory:         已记住的用户信息（默认已经拼成 system 消息放进 messages，这里给的是原始对象）
  // knowledge:      知识库配置，见下面「知识库与引用」
  // onDelta(deltaText, fullText):  每收到一段就调一次，界面据此流式渲染
  // onReferences(list):            知识库命中的资料，界面渲染成可展开的「参考资料」
  //                                每项 { title, url?, snippet? }
  // 返回：最终全文（string），或 { text, references }
}
```

注册自定义实现：

```js
WebAIAssistant.defineTransport('my-gateway', async (ctx) => { /* … */ });
WebAIAssistant.mount({ transport: 'my-gateway', endpoint: '/api/chat' });
```

内置三个：

| 名字 | 用途 |
|---|---|
| `openai` | OpenAI 兼容协议（`POST{model,messages,stream}` + SSE）。百炼 compatible-mode、vLLM、Ollama、one-api 这类网关都能用 |
| `dashscopeApp` | 百炼**智能体应用**直连（`/api/v1/apps/{appId}/completion`）。已经建了智能体应用、不想再套一层网关时用 |
| `echo` | 不发网络请求的本地假回复。开发预览、写自动化验收时用，**上线前换成真实的** |

内置的两个协议实现都会**自动识别**常见的引用字段（`references` / `citations` / `sources` / `search_info` / `doc_references`，
以及每项里的 `title|name|doc_name`、`url|link|doc_url`、`snippet|content|text`），
所以大多数自建 RAG 后端不用改代码就能把引用显示出来。

## 后端代理（唯一能安全放 key 的地方）

前端契约是 `{messages} → SSE 文本流`。后端负责翻译成上游协议。换模型只改这里。

### FastAPI

```python
import json, os
import httpx
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

UPSTREAM = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
MODEL = os.getenv("ASSISTANT_MODEL", "qwen-plus")
SYSTEM = os.getenv("ASSISTANT_SYSTEM", "你是本站的客服助手，只回答与本站产品相关的问题。")

app = FastAPI()

@app.post("/api/assistant/chat")
async def chat(request: Request):
    body = await request.json()
    messages = (body.get("messages") or [])[-12:]          # 只带最近 12 轮，防止上下文无限增长
    payload = {
        "model": MODEL,
        "messages": [{"role": "system", "content": SYSTEM}, *messages],
        "stream": True,
    }
    headers = {"Authorization": f"Bearer {os.environ['DASHSCOPE_API_KEY']}"}

    async def relay():
        async with httpx.AsyncClient(timeout=60) as client:
            async with client.stream("POST", UPSTREAM, json=payload, headers=headers) as r:
                if r.status_code != 200:
                    detail = (await r.aread()).decode("utf-8", "ignore")[:200]
                    # 用 OpenAI 兼容的错误形状回给前端，挂件会把它显示成错误气泡
                    yield "data: " + json.dumps({"error": {"message": f"上游 {r.status_code}：{detail}"}}) + "\n\n"
                    return
                async for line in r.aiter_lines():
                    if line.startswith("data:"):
                        yield line + "\n\n"

    return StreamingResponse(relay(), media_type="text/event-stream")
```

### Node（Express）

```js
import express from 'express';

const app = express();
app.use(express.json());

app.post('/api/assistant/chat', async (req, res) => {
  const messages = (req.body.messages || []).slice(-12);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const upstream = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.ASSISTANT_MODEL || 'qwen-plus',
      messages: [{ role: 'system', content: '你是本站的客服助手…' }, ...messages],
      stream: true
    })
  });

  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 200);
    res.write(`data: ${JSON.stringify({ error: { message: `上游 ${upstream.status}：${detail}` } })}\n\n`);
    return res.end();
  }

  const reader = upstream.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));     // 原样转发 SSE 帧
  }
  res.end();
});
```

### 代理层必须做的四件事

- **CORS**：挂件和接口同源时无需配置。不同源要显式放行来源，**不要** `Access-Control-Allow-Origin: *` 配上带凭证的接口。
- **限流**：公开接口一定会被人刷。按 IP 或会话做最简单的计数限流，比事后看账单便宜。
- **入参白名单**：不要 `{...req.body}` 直接透传给上游。只取 `messages`，并且校验 `role` 在 `user`/`assistant` 里、`content` 是字符串且长度有上限。否则别人可以顺手把你这里当成任意模型的免费网关。
- **`X-Accel-Buffering: no`**：如果前面有 Nginx，必须加这个响应头，否则 Nginx 会缓冲整个响应，流式变成"憋一大段再一次性吐出来"。

## 挂载

### 静态站 / 服务端模板

```html
<script src="/static/ai-assistant.js"
        data-waa
        data-name="小助"
        data-transport="openai"
        data-endpoint="/api/assistant/chat"
        data-model="qwen-plus"
        data-greeting="关于这台机器，你想问什么？"
        data-suggestions="保修怎么查|能开发票吗|多久到货"></script>
```

`data-suggestions` 用 `|` 分隔。加上 `data-waa` 属性即自动挂载，脚本自己等 `DOMContentLoaded`。

### SPA（React / Vue）

不要在组件里 mount——路由来回会挂出好几个挂件。放在应用入口，挂一次：

```js
// React: main.tsx，渲染完根组件之后
import '@/widget/ai-assistant.js';
import cssUrl from '@/widget/ai-assistant.css?url';   // Vite 写法

window.WebAIAssistant.mount({
  cssUrl,                        // 打包后必须显式给，否则挂件会无样式渲染
  name: '小助',
  transport: 'openai',
  endpoint: '/api/assistant/chat',
  model: 'qwen-plus',
  suggestions: ['保修怎么查', '能开发票吗'],
  // 把路由信息喂给后端，助手才知道用户在看什么
  extraInfo: () => ({ currentPage: location.pathname })
});
```

Vue 同理，放 `main.ts`。如果一定要放组件里，用模块级 flag 守住：

```js
let mounted = false;
onMounted(() => {
  if (mounted) return;
  mounted = true;
  window.WebAIAssistant.mount({ /* … */ });
});
```

**打包场景必须给 `cssUrl`。** 挂件默认按自己的 `<script src>` 去找同目录同名的 `.css`——
静态站这样最省事。但打包之后 `script.src` 变成了 `assets/index-a1b2c3.js` 这种带哈希的
bundle 名，猜不到样式表，挂件就会以**无样式状态**渲染。这种情况下挂件会在控制台打一条
`warn`，但更稳妥的做法是显式传：`cssUrl`（Vite 用 `?url` 导入）或 `css`（直接给字符串）。

## 配置项

完整列表见 `assets/widget/ai-assistant.js` 顶部的 `DEFAULTS`。常用的：

| 键 | 默认 | 说明 |
|---|---|---|
| `name` | `'助手'` | 标题栏里的名字 |
| `greeting` | — | 空态问候语。**按业务亲手写**，别用套话 |
| `suggestions` | `[]` | 空态的问题示例，2–4 条，比任何说明文字都有用 |
| `hotWords` | — | 热词，`['a','b']` 或 `[{text, weight}]` |
| `hotWordsUrl` | — | 从后端拉热词；返回数组或 `{items:[]}`。拉不到就用静态的兜底 |
| `hotWordsRefresh` | `0` | 毫秒；>0 时定时重拉（热榜会变，这个才有意义） |
| `hotWordsPlacement` | `'both'` | `'empty'`（只在空态）/ `'composer'`（只做输入框上方的常驻条）/ `'both'` / `'off'` |
| `transport` / `endpoint` / `model` / `apiKey` / `appId` | — | 后端对接 |
| `provider` | — | 大模型服务商预设，见「内嵌大模型 API」一节 |
| `auth` | 跟随 provider | `'bearer'` / `'x-api-key'` / `'none'` |
| `headers` / `body` | — | 附加到请求上的头与字段（例如自研网关要的租户头） |
| `retrieve` | — | `async (query, {messages}) => [{title,url,snippet}]`。前端检索钩子，适合知识库就在同源后端的场景 |
| `knowledge` | — | 知识库配置（`{id, name, topK, mode}`），会随请求下发给后端 |
| `memory` | `true` | 是否启用记忆（持久化 + 随请求发送） |
| `memoryForward` | `'system'` | `'system'`：把记忆拼成一条 system 消息（兼容性最好）；`'body'`：作为 `memory` 字段放进请求体，给自研后端用 |
| `memorySystem` | `true` | 是否用 system 消息承载记忆 |
| `memoryPrompt` | 见源码 | 记忆那段 system 消息的开头语 |
| `history` | `true` | 是否启用多会话历史 |
| `maxThreads` | `40` | 最多保留多少个会话，超出丢最旧的 |
| `storage` | `'session'` | `'session'`（关标签页就清）/ `'local'`（跨访问保留）/ `'none'` |
| `storageKey` | `'waa'` | 存储键。同域多个挂件要区分开 |
| `closeOnOutsideClick` | `true` | 点面板以外的任何地方收起 |
| `outsideIgnore` | — | 选择器或数组。站点自己的弹层被误判成"外部点击"时，把它的选择器放进来豁免 |
| `closeOnEsc` | `true` | Esc 收起（抽屉打开时 Esc 先关抽屉） |
| `shortcuts` | `true` | 快捷键总开关 |
| `hotkeys` | — | 按动作名覆盖默认组合键，例如 `{ toggle: 'mod+shift+k', help: false }` |
| `shortcutHelp` | `true` | 是否提供快捷键help面板 |
| `theme` | `'auto'` | `auto` / `light` / `dark` |
| `position` | `'right'` | `right` / `left` |
| `draggable` / `autoOpen` | `true` / `false` | 启动器可拖 / 加载后自动展开 |
| `accent` / `radius` | — | 直接覆盖主色与圆角 |
| `css` / `cssUrl` | — | 完全替换内置样式表 |
| `zIndex` | `2147483000` | 被导航栏盖住时调这个 |
| `extraInfo` | — | 对象或函数，随**每一次**请求发送的业务上下文 |
| `onBeforeSend` | — | 返回 `false` 可拦截发送（内容审核、敏感词） |
| `onAfterSend` | — | `({messages, reply, references, threadId})`，用来埋点、留痕、顺手写记忆 |
| `onError` / `onThreadChange` | — | 上报错误 / 会话列表变化时回调 |
| `echoReply` | — | `transport: 'echo'` 时用的假回复文案 |

## 会话历史、新对话与记忆

三者是一套东西，共用一份存储（`storageKey` 下），互相关联但语义不同：

| | 是什么 | 生命周期 |
|---|---|---|
| **新对话** | 开一条空白会话。标题栏的 `+`，或 `widget.newThread()` | 旧会话进历史列表 |
| **历史记录** | 多条会话，可切换、删除、清空。标题栏的列表图标打开抽屉 | 受 `storage` 与 `maxThreads` 控制 |
| **记忆** | 关于**这个人**的零散事实（门店、机型、偏好…），和会话无关 | 一直留着，直到被覆盖或清空 |

界面上：标题栏 `+` = 新对话，列表图标 = 历史与记忆抽屉（下半区就是记忆，逐条列出来，可一键清空）。

代码里：

```js
w.newThread();                  // 新对话（当前会话已经是空的就不重复开）
w.listThreads();                // [{id, title, updatedAt, count, active}]
w.openThread(id);
w.deleteThread(id);
w.clearAll();                   // 历史和记忆一起清掉（会先 confirm）

w.remember({ 门店: '杭州西湖店' });   // 合并写入
w.forget('门店');                    // 或 forget() 清空
w.getMemory();
```

**记忆默认怎么用**：`memory` 非空时，每次请求会在 `messages` 最前面插一条 system 消息
（内容 = `memoryPrompt` + 逐条列出的事实）。这样对任何 OpenAI 兼容后端都生效，不需要后端配合。
想让后端拿到**原始对象**自己做处理（比如写进数据库），把 `memoryForward` 设成 `'body'`，
它就会作为 `memory` 字段出现在请求体里。

**该记什么**：记稳定的事实（他是谁、买过什么、偏好什么），别记临时状态（"他刚问了运费"）。
记忆是一段会一直发给模型的文本，塞得越碎，噪音越大。摘要式的一条比十条碎片有用。

## 快捷键

默认这一套（Mac 上 `mod` 是 ⌘，其它平台是 Ctrl）：

| 按键 | 作用 |
|---|---|
| `mod + K` | 打开 / 收起助手 |
| `mod + /` | 显示快捷键面板 |
| `mod + shift + H` | 历史与记忆 |
| `mod + shift + O` | 新对话 |
| `Esc` | 收起（抽屉打开时先关抽屉） |
| `Alt + ↑` / `Alt + ↓` | 上一个 / 下一个会话 |
| `Enter` | 发送 |
| `Shift + Enter` | 换行 |
| `mod + Enter` | 发送（任何情况下） |
| `↑` | 取回上一条提问（输入框为空时） |

面板里按 `mod + /` 就能看到这份表，不用翻文档。

覆盖或关掉单个按键：

```js
WebAIAssistant.mount({
  hotkeys: {
    toggle: 'mod+shift+k',   // 换一个
    newChat: false           // 或者直接禁用
  }
});
```

组合键写法：`mod+k`、`alt+arrowup`、`shift+enter`、`escape`。`mod` 会按平台自动映射成 ⌘ / Ctrl。

**两条设计上的取舍**，改之前请先理解：

1. **焦点在站点自己的输入框里时，全局键不抢。** 否则会把人家搜索框的 `Ctrl+K` 吃掉——这类"我们的挂件把人家网站弄坏了"的投诉很难查。判断用的是事件 `composedPath()` 的原始目标，因为 Shadow DOM 冒泡到 document 时 target 会被重定向成宿主元素。
2. **输入法组合过程中不响应**（`isComposing` / `keyCode === 229`），否则中文输入时按 Enter 选词会误发消息。

整块关掉：`shortcuts: false`。

## 内嵌大模型 API（provider 预设）

`provider` 帮你把"地址 + 鉴权方式 + 协议适配器"一次配好，省去抄文档：

```js
WebAIAssistant.mount({
  provider: 'deepseek',
  apiKey: '…',
  model: 'deepseek-chat'      // 不填就用预设的默认模型
});
```

| provider | 协议 | 说明 |
|---|---|---|
| `openai` | OpenAI | `api.openai.com` |
| `dashscope` | OpenAI 兼容 | 阿里云百炼兼容模式 |
| `dashscopeApp` | 智能体应用 | 需要 `appId`；知识库在百炼控制台配 |
| `deepseek` | OpenAI 兼容 | DeepSeek |
| `moonshot` | OpenAI 兼容 | 月之暗面 Kimi |
| `zhipu` | OpenAI 兼容 | 智谱 GLM |
| `siliconflow` | OpenAI 兼容 | 硅基流动 |
| `openrouter` | OpenAI 兼容 | OpenRouter |
| `ollama` | OpenAI 兼容 | 本机 `localhost:11434`，不需要 key |
| `vllm` | OpenAI 兼容 | 自建 vLLM / 网关 |
| `anthropic` | **Anthropic Messages** | 单独的适配器：system 是顶层字段、SSE 按 `type` 分事件、正文在 `content_block_delta.delta.text` |

也可以只指定协议，自己填地址：

```js
WebAIAssistant.mount({ transport: 'anthropic', endpoint: '…', model: '…', apiKey: '…' });
```

看得到全部预设：`WebAIAssistant.providers`。

**模型名会随各家迭代而变**，预设里的只是一个能跑起来的起点，以官方文档为准；用 `model` 覆盖即可，不必改挂件代码。

### ⚠ 把 key 写在浏览器里 = 公开

上面这段代码只适合**本机开发、内网、或 Ollama 这类不需要 key 的场景**。放在公开网站上，任何访客按 F12 就能拿到你的 key。生产环境只有一种正确做法：

```
浏览器  ──►  你自己的后端（key 在这里）  ──►  大模型 API
```

后端只要把 `{messages}` 转成上游协议、把 SSE 原样转发回来即可，`transports.openai` 会自动解析。FastAPI / Node 两份现成实现见上面「后端代理」一节。

从浏览器**直连** Anthropic 需要额外的 `anthropic-dangerous-direct-browser-access: true` 头（挂件在你传 `allowBrowserDirect: true` 时会自动带上），而且服务商普遍不建议这么做——同样请走后端代理。

## 知识库与引用（RAG）

挂件不实现检索，它负责**把检索这件事接进来，并把命中的资料显示出来**。三种接法：

**1）后端已经在做检索（最常见）**
你的接口返回里带上引用，字段名随便——内置的 `openai` / `dashscopeApp` 认识
`references` / `citations` / `sources` / `search_info` / `doc_references` 这几种。例如：

```json
{
  "choices": [{ "message": { "content": "整机保修 3 年…" } }],
  "references": [
    { "title": "A1 保修条款.pdf", "url": "https://…/warranty", "snippet": "整机保修 3 年，机芯 5 年。" }
  ]
}
```

**2）流式场景：边流边给引用**
SSE 的任意一帧里带 `references` 就会被抓走，界面在回复下方渲染成可展开的「参考资料」。

**3）知识库就在同源后端**
用 `retrieve` 钩子，省一次协议往返：

```js
retrieve: async (query) => {
  const r = await fetch('/api/kb/search?q=' + encodeURIComponent(query));
  return r.json();     // [{title, url, snippet}]
}
```

`retrieve` 抛错不会拦住对话——检索失败就当作没有引用，助手照常回答。

百炼/AppFlow 一侧的检索怎么配（数据连接 → 知识库 → 应用挂载 → 必定调用），
见 `console-setup.md` 第 4 步。走路径 A（官方挂件）时引用由 AppFlow 自己的界面负责，
不需要挂件参与。

**配置下发**：`knowledge` 会原样放进请求体（`openai` 协议）或作为参数传给智能体应用，
后端可以据此决定用哪个库、召回几条：

```js
knowledge: { id: 'kb_yejing', name: '野径咖啡知识库', topK: 4, mode: 'always' }
```

## 关于 `extraInfo` 与 `onBeforeSend`

后端拿到业务上下文才能答得具体。默认实现里 `extraInfo` 会被合并进请求体（放在 `body` 里一起 POST）。如果后端是自研的，记得在代理里把它取出来用：

```js
const { messages, extraInfo } = req.body;
console.log('用户在看：', extraInfo?.currentPage);
```

`onBeforeSend` 是接内容审核的位置：返回 `false` 就不发，并且可以先自己往界面里插一条提示。

## 删干净

挂件是绝对增量的：

```
删掉 ai-assistant.js、ai-assistant.css  ← 挂件的全部文件
删掉 index.html 里那一个 <script data-waa …> 标签   ← 唯一的引用点
```

站点回到原状。**不要在站点代码里为挂件做任何其他改动**——如果你发现必须改动站点才能挂上，先停下来想想是不是挂件本身该改。
