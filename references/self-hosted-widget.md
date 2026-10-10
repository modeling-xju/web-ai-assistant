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
async function transport({ messages, config, signal, onDelta }) {
  // messages: [{ role: 'user' | 'assistant', content: string }]
  // config:   挂件的全部配置（endpoint / model / apiKey / headers / …）
  // signal:   AbortSignal，用户点"停止"时会 abort，你要把它透传给 fetch
  // onDelta(deltaText, fullText): 每收到一段就调一次，界面据此流式渲染
  // 返回：最终全文（string）
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

| 键 | 说明 |
|---|---|
| `name` | 标题栏里的名字 |
| `greeting` | 空态问候语。**按业务亲手写**，别用套话 |
| `suggestions` | 空态的问题示例，2–4 条，比任何说明文字都有用 |
| `transport` / `endpoint` / `model` / `apiKey` / `appId` | 后端对接 |
| `headers` / `body` | 附加到请求上的头与字段（例如自研网关要的租户头） |
| `theme` | `auto`（跟随系统）/ `light` / `dark` |
| `position` | `right` / `left` |
| `draggable` / `autoOpen` | 启动器可拖 / 加载后自动展开 |
| `accent` / `radius` | 直接覆盖主色与圆角 |
| `css` / `cssUrl` | 完全替换内置样式表 |
| `persist` / `sessionKey` | 会话是否保留在 sessionStorage |
| `zIndex` | 默认 `2147483000` |
| `extraInfo` | 对象或函数，随**每一次**请求发送的业务上下文 |
| `onBeforeSend` | 返回 `false` 可拦截发送（内容审核、敏感词） |
| `onAfterSend` / `onError` | 埋点、留痕、上报 |

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
