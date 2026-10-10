# AppFlow Chat SDK 参考

官方挂件的全部能力都来自一个全局对象 `window.APPFLOW_CHAT_SDK`。**写代码前读这一页，不要凭记忆写 API**——参数名拼错的后果是静默失败，不报错。

来源：阿里云帮助中心《AI 助手集成 FAQ》（计算巢 / AppFlow Chat SDK）。SDK 版本 `v1`。

## 引入

```html
<script src="https://o.alicdn.com/appflow/chatbot/v1/AppflowChatSDK.js"></script>
```

唯一官方 CDN。不要镜像、不要本地缓存后改版本号——挂件内部与 `requestDomain` 强绑定。

## 目录

- [`init(options)`](#init)
- [`setUser(user)`](#setuser)
- [`setExtraInfo(extraInfo, isGlobal)`](#setextrainfo)
- [`onBeforeSend(handler, options)`](#onbeforesend)
- [`onAfterSend(handler, options)`](#onaftersend)
- [`close()`](#close)
- [消息对象结构](#消息对象结构)
- [初始化时序（重要）](#初始化时序)

---

## init

```js
window.APPFLOW_CHAT_SDK.init({
  integrateConfig: {
    integrateId: '你的集成ID',
    domain: {
      requestDomain: 'https://xxx.appflow.aliyunnest.com'
    }
  }
});
```

所有参数都挂在 `integrateConfig` 下（注意这层嵌套，是最常见的拼错点）。

### integrateConfig 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `integrateId` | string | 是 | 在 AI 助手详情 → 页面集成 里创建集成后得到的 ID |
| `domain.requestDomain` | string | 是 | 你自己的 AppFlow 域名，形如 `https://xxx.appflow.aliyunnest.com`。**必须来自你自己的集成页面** |
| `initialMessage` | string | 否 | 打开时预填到聊天框的一条消息 |
| `initialMessageAutoSend` | string | 否 | 预填的消息是否自动发出并请求 AI 回复。默认 `false`（只填入输入框，不发请求） |
| `draggable` | boolean | 否 | 悬浮框是否可拖动 |
| `autoOpen` | boolean | 否 | 页面加载后是否自动展开悬浮框。默认关闭，一般保持关闭——访客刚进站就被弹窗打扰是负面体验 |
| `customStyle.containerStyle` | object | 否 | 面板整体尺寸：`width` / `height` / `maxWidth` / `maxHeight`，接受 CSS 长度字符串。面板 = 标题栏 + 聊天区 + 输入区 |
| `customStyle.botBubbleStyle` | object | 否 | AI 回复气泡宽度：`width` / `maxWidth` |

```js
window.APPFLOW_CHAT_SDK.init({
  integrateConfig: {
    integrateId: '你的集成ID',
    domain: { requestDomain: 'https://xxx.appflow.aliyunnest.com' },
    draggable: true,
    autoOpen: false,
    initialMessage: '我想了解产品报价',
    customStyle: {
      containerStyle: { width: '420px', height: '90%', maxHeight: '700px', maxWidth: '420px' },
      botBubbleStyle: { width: '100%', maxWidth: '100%' }
    }
  }
});
```

字体颜色、背景色、头像、预置问题这些**不在 init 里配**，是在控制台「页面集成」详情页的右方可视化界面里改，改完点提交。想在代码里控制颜色只能靠站点 CSS 覆盖（脆弱，不推荐）或去控制台改（推荐）。

## setUser

设置当前访客信息，会作为 `userInfo` 字段随聊天请求传给大模型。

```js
window.APPFLOW_CHAT_SDK.setUser({
  userId: 'u-123',            // 用户唯一标识
  userName: '张三',
  userAvatar: 'https://…/a.png'
});
```

三个字段都可选。**未登录的访客不要伪造 `userId`**——用 `setExtraInfo` 传匿名标识更诚实，也避免污染业务数据。

## setExtraInfo

```js
setExtraInfo(extraInfo: any, isGlobal?: boolean): void
```

把业务上下文传给大模型。这是让助手从"通用客服"变成"懂我网站的助手"的关键手段，成本极低但经常被漏掉。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `extraInfo` | object | 是 | — | 要传的参数对象 |
| `isGlobal` | boolean | 否 | `false` | `true` = 全局参数（持久保存，之后每条消息都带）；`false` = 临时参数（只在**下一次**发送时带） |

合并规则：全局 + 临时同时存在时合并传递，**同名字段临时参数覆盖全局参数**。

**选哪个**：用户身份、租户、语言这类会话级的不变量用全局；"当前在看哪个商品/哪个页面"这类随页面变的一次性上下文用临时。别把易变的东西设成全局，否则会串味。

```js
// 全局：登录后设置一次
window.APPFLOW_CHAT_SDK.setExtraInfo({ userId: 'u-1', tenantId: 't-01', language: 'zh-CN' }, true);

// 临时：进入商品详情页时设置
window.APPFLOW_CHAT_SDK.setExtraInfo({ currentPage: location.pathname, productId: 'SKU-123' });
```

## onBeforeSend

```js
onBeforeSend(
  handler: (params: { userMessage: UserMessage }) => void | Promise<void>,
  options?: { async?: boolean }
): void
```

发送前的钩子。典型用途：埋点、内容预处理、按消息内容动态补 `extraInfo`。

- **只能注册一个**，重复调用会覆盖前一个。多处需要逻辑就自己在 handler 里分发。
- 同步模式（默认）：**不等待** handler 返回的 Promise，消息立即发出。适合埋点。
- 异步模式（`{ async: true }`）：等待 Promise 完成才发送。适合内容审核、拉取用户上下文。异步 handler 抛错会影响发送，务必 try-catch。

## onAfterSend

```js
onAfterSend(
  handler: (params: AfterSendParams) => void | Promise<void>,
  options?: { async?: boolean }
): void
```

回复完成后（成功或失败）的钩子。**只能注册一个。**

成功时 `params`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `userMessage` | UserMessage | 用户发的内容 |
| `assistantContent` | string | AI 回复的完整文本 |
| `assistantReferences` | array | 引用的知识库文档列表 |

失败时 `params`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `userMessage` | UserMessage | 用户发的内容 |
| `error.message` | string | 错误描述 |
| `error.code` | string | 错误码 |

用 `params.success` 区分。用它做对话留痕、满意度埋点、把问答对回写业务系统。

```js
window.APPFLOW_CHAT_SDK.onAfterSend(async (params) => {
  try {
    await fetch('/api/conversation/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: params.userMessage,
        a: params.success ? params.assistantContent : null,
        refs: params.success ? params.assistantReferences : [],
        err: params.success ? null : params.error
      })
    });
  } catch (e) { /* 日志失败不能影响用户体验 */ }
}, { async: true });
```

## close

```js
window.APPFLOW_CHAT_SDK.close();
```

收起聊天悬浮框。适合"站内路由切换时收起"或"用户点了别处"的场景。

## 消息对象结构

`userMessage` 是 UserMessage。通用字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `messageType` | `'text' \| 'rich' \| 'audio' \| 'event' \| 'card_call_back'` | 消息类型 |
| `sessionId` | string | 当前会话 ID |
| `chatbotId` | string | AI 助手 ID |
| `chatbotModelId` | string | 模型 ID |
| `userInfo` | object | 通过 `setUser` 设置 |
| `extraInfo` | object | 通过 `setExtraInfo` 设置 |
| `config` | object | 配置信息（如联网搜索） |

各类型专有字段：

```js
// text —— 最常见。注意内容是 text.content，不是顶层 content
{ messageType: 'text', text: { content: '用户输入的文本' } }

// rich —— 文本 + 图片 + 文件
{ messageType: 'rich', richText: [
  { type: 'text',  content: '…' },
  { type: 'image', mediaUrl: 'https://…' },
  { type: 'file',  mediaUrl: 'https://…', mediaId: '…' }
] }

// audio
{ messageType: 'audio', audio: { mediaUrl: 'https://…', mediaType: 'wav' } }

// event —— 系统事件，如上传文件
{ messageType: 'event', event: { eventType: 'uploadFile', content: '{...JSON 字符串}' } }

// card_call_back —— 审批类卡片回调
{ messageType: 'card_call_back', cardCallBack: { data: {} } }
```

写埋点时如果只想记文本，先判断 `messageType === 'text'` 再取 `text.content`；对 `rich` 要拼 `richText` 里的 text 片段。直接取 `.content` 会在 rich 消息上得到 `undefined`。

## 初始化时序

这是最容易踩的坑，单独说。

内联 `<script>` 在解析到时**立即执行**，而带 `defer` 的外链脚本要等文档解析完才执行。所以下面这种写法**必然报 `APPFLOW_CHAT_SDK is undefined`**：

```html
<!-- 错的 -->
<script src="https://o.alicdn.com/appflow/chatbot/v1/AppflowChatSDK.js" defer></script>
<script>window.APPFLOW_CHAT_SDK.init({ … });</script>
```

而下面这种（都不加 defer）虽然能跑，但会阻塞首屏解析：

```html
<!-- 能跑，但拖慢首屏 -->
<script src="https://o.alicdn.com/appflow/chatbot/v1/AppflowChatSDK.js"></script>
<script>window.APPFLOW_CHAT_SDK.init({ … });</script>
```

推荐：SDK 加 `defer`，init 写在 `load` 事件里，或者写成小轮询兜底。`assets/appflow-snippet.html` 里给了带兜底的写法，直接用那个。

另外：**SPA 里只 init 一次**。放在组件 `mounted`/`useEffect` 里会在路由来回时反复 init，表现为多个图标叠在一起或行为错乱。放到应用入口、或用一个模块级 flag 守住。
