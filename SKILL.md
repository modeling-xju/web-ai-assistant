---
name: web-ai-assistant
description: 给网站内嵌一个 AI 助手（悬浮聊天挂件 / AI 客服 / 网站问答机器人 / website chat widget / embedded AI assistant / chatbot bubble）。覆盖两条路——接阿里云百炼 + AppFlow 官方悬浮挂件（AppflowChatSDK），以及零依赖自建挂件（Shadow DOM 隔离、SSE 流式、后端 adapter 可替换）。也用于排查已有挂件故障：对话报 request error、Failed to stream content、图标不出来、与站点样式互相污染、API Key 泄漏在前端、知识库答不准。当用户提到「AI 助手」「AI 客服」「智能客服」「在线客服」「聊天挂件」「悬浮窗」「右下角客服」「网站问答」「知识库问答」「百炼」「AppFlow」「智能体应用」「embedded assistant」「chat widget」「support bubble」时都应使用本 skill，哪怕用户没有说出「挂件」两个字，哪怕他只是说「想让网站能回答访客的问题」。
---

# 给网站内嵌 AI 助手

把一个能对话的 AI 助手挂到用户已有的网站上，并且**不破坏他原来的站**。

"内嵌"这个词有三层含义，缺一层都不算交付：

1. **能出得来**——访客在页面上看得见入口、点得开、打得出字、收得到回复。
2. **不打架**——挂件的样式/脚本不能污染站点，站点的样式/脚本也不能弄坏挂件。
3. **可换血**——模型供应商、后端地址、密钥这些明天就会变的东西，不能在代码里焊死。

## 动手前先问清三件事

不要跳过这一步直接写代码。这三件事决定了后面 90% 的实现细节，猜错会白干：

1. **走哪条路？** 见下面的判定表。如果用户已经提到了百炼/AppFlow/智能体应用，默认走 A；如果用户没有阿里云账号、或者在本地开发、或者要私有部署，走 B。
2. **站点是什么形态？** 纯静态 HTML / Vite-Webpack 打包的 SPA / Vue-React 组件树 / 服务端模板（JSP-PHP-Django）。这决定了"插几行代码"插在哪一个文件，以及挂件能不能用 ES module。
3. **谁来付模型的钱、密钥放在哪？** 这是唯一一个**必须**较真的安全项：
   - 用户已经有后端 → key 放后端，前端只打自己的接口。
   - 用户只有静态托管（GitHub Pages / OSS / CDN）→ 要么加一个极薄的代理（云函数 / Serverless / Nginx），要么用 AppFlow 的集成 ID（它本来就是给前端用的公开标识）。
   - 用户坚持把 key 写进前端 → **明确告诉他这等于把 key 公开**，然后照他说的做，但在交付说明里留一行风险记录。不要偷偷照做，也不要因此拒绝干活。

## 判定表

| 用户情况 | 走哪条路 | 读哪个 |
|---|---|---|
| 已有百炼应用 + AppFlow 集成 ID，要最快见效 | **A** 官方悬浮挂件 | `references/appflow-sdk.md` |
| 只有百炼应用（有应用 ID + API Key），没有 AppFlow | **B** 自建挂件 + 百炼兼容模式 | `references/self-hosted-widget.md` |
| 没有任何大模型账号，或要本地跑通 / 私有部署 / 换自研模型 | **B** 自建挂件 + 自写 adapter | `references/self-hosted-widget.md` |
| 已经嵌过但坏了 | 先读 `references/troubleshooting.md` 定位，再回到对应路径 | `references/troubleshooting.md` |
| 要把公司文档喂给助手（RAG） | 与 A/B 正交，任何一条路都能接 | `references/console-setup.md` 第 4 步 |

## 路径 A：接官方 AppFlow 悬浮挂件

AppFlow 的挂件是**一段外部 SDK + 一段 init 配置**，官方托管在 `o.alicdn.com`，所以对前端来说是安全的（前端只暴露 `integrateId` 和 `requestDomain`，不暴露 API Key）。

**A1 · 让用户去控制台把四件事做完**（你点不了控制台，这一步要交给用户，并且给他可以照着走的清单）：

1. 百炼控制台 → 应用管理 → 创建**智能体应用** → 写角色 Prompt → 发布。
2. 抄下**应用 ID**；到密钥管理创建 **API Key**。
3. AppFlow 控制台 → 模型服务 → **AI 助手** → 创建 → **导入模型**（选阿里云百炼，填 API Key + 应用 ID）。
4. AI 助手详情 → 页面集成 → **创建集成**（可在此调字体颜色、头像、预置问题）→ 提交。

完整分步说明（含每一步在页面哪个位置、常见填错的地方）在 `references/console-setup.md`。

**A2 · 拿到三样东西再动手**：`integrateId`、`requestDomain`（形如 `https://xxx.appflow.aliyunnest.com`）、以及页面集成里「登录配置」选的鉴权方式。**不要凭想象编 `requestDomain`**——编错了就是 `Failed to stream content` 的标准成因。

**A3 · 往站里插代码**。可直接用的模板在 `assets/appflow-snippet.html`，把它读出来改。插法要点：

- 两个 `<script>` 都放在 `</body>` 前，**不要**放到 `<head>` 里阻塞首屏，也**不要**放进 SPA 里只挂载一次的组件（会重复 init）。
- 引用 SDK 的那个 `<script>` 加 `defer`；init 的那个放在它后面（内联脚本天然晚于 defer 脚本执行？不——内联脚本会先执行。所以 init 必须包在 `window.addEventListener('load', …)` 里，或者用 `defer` 的加载完成回调。这是最常见的"挂件不出图标"成因）。
- 跑 `scripts/verify-embed.mjs` 检查一遍再交付。

**A4 · 按需加配置**：`draggable` / `autoOpen` / `initialMessage` / `customStyle` / `setUser` / `setExtraInfo` / `onBeforeSend` / `onAfterSend` / `close`。每个参数的确切类型和语义见 `references/appflow-sdk.md`，**不要猜 API**。

**A5 · 把站点上下文喂给助手**（这一步价值极高但经常被漏掉）。用 `setExtraInfo` 把"用户此刻在哪个页面、看的是哪个商品、是不是登录用户"传进去，助手才能答得具体：

```js
window.APPFLOW_CHAT_SDK.setExtraInfo({
  currentPage: location.pathname,
  pageTitle: document.title,
  productId: new URLSearchParams(location.search).get('id') || undefined,
}, true);   // isGlobal=true：之后每条消息都带
```

## 路径 B：自建挂件

适用于没有 AppFlow、要私有部署、要本地开发验证、或要对接自研模型的情况。

**B1 · 拷贝挂件**。`assets/widget/` 下是两个零依赖文件（`ai-assistant.js` + `ai-assistant.css`），拷到站点的静态目录。它用 Shadow DOM 把样式完全关在自己的影子里，不会和站点互相污染——这是自建方案能不能"不打架"的关键，别改成普通 div。

**B2 · 写后端代理**。这是自建路径的核心工作量，也是唯一能安全放 key 的地方。注意**不要把大模型协议散落进前端**：前端只认一个 `{messages} → SSE 文本流` 的契约，换模型只改后端。`references/self-hosted-widget.md` 里有可直接用的 FastAPI / Node 两个版本，以及百炼兼容模式与智能体应用两种上游写法。

**B3 · 挂载**。静态站用 `data-*` 属性自动挂载（见 `assets/embed-selfhosted.html`）；SPA 用 `WebAIAssistant.mount({...})`，放在根组件挂载后调用一次。

**B4 · 换皮**。默认配色由 CSS 自定义属性驱动（`--waa-accent` / `--waa-bg` / `--waa-ink` / `--waa-radius` …），改几个变量就能融进站点。想调整观感时先读 `references/design.md`——里面写了这个挂件为什么长这样，以及哪些做法会让它一眼看出是"AI 生成的组件"。

**B5 · 别重复造这些轮子。** 挂件已经内置了这些能力，用户提出相关需求时是**配置**问题，不是开发问题：

| 用户说 | 你该做的 |
|---|---|
| "点别处要能收起" | 默认就开着（`closeOnOutsideClick`）。只有要关掉时才动配置 |
| "要有历史记录 / 新对话" | 默认就有（`history: true`）。要跨访问保留就把 `storage` 设成 `'local'` |
| "要能记住用户" | 用 `widget.remember({...})` 写入，随请求自动带上。该记稳定事实，别记临时状态 |
| "要热词 / 热门问题" | `hotWords` 静态兜底 + `hotWordsUrl` 从后端拉（`{items:[...]}`），见 `references/self-hosted-widget.md` |
| "要接知识库 / 要能引用资料" | 挂件负责**显示**引用、**下发**配置；检索在你自己后端做。见 `self-hosted-widget.md` 的「知识库与引用」 |
| "要能按快捷键唤起" | 默认就有：`mod+K` 开合、`mod+/` 看快捷键表、`Alt+↑↓` 切会话。要改传 `hotkeys`，整块关掉传 `shortcuts: false` |
| "直接接某家大模型 API" | 用 `provider` 预设（OpenAI / 百炼 / DeepSeek / Kimi / GLM / SiliconFlow / OpenRouter / Ollama / vLLM / Anthropic）。**但先解决 key 放哪**——见下 |

**关于 provider：先问 key，再写代码。** 如果用户是在做公开网站，`provider` + `apiKey` 直接写在页面里等于把 key 公开。
这时候正确的话术是："预设我可以用，但 key 得放后端，前端打你自己的接口"——然后给他后端代理的骨架
（`self-hosted-widget.md` 的「后端代理」有 FastAPI / Node 两份）。
只有本机开发、内网、或 Ollama 这类不需要 key 的场景，才可以直接连。

动手写代码之前先确认这些确实不满足需求——把已有能力重写一遍是这条路上最常见的浪费。

## 两条路共用的硬性约束

这些不是风格建议，是返工成本最高的几个坑：

- **只增不改。** 用户要的是"加一个助手"，不是"重写我的网站"。不重构既有函数、不改既有接口/数据结构、不动构建配置。挂件应当是**加进去就能删干净**的东西——交付时明确告诉用户"删掉这两行/这两个文件就恢复原状"。
- **样式必须隔离。** Shadow DOM 或 iframe，二选一。直接往 `document.body` 塞带全局类名的 div，迟早会在某个页面上被站点的 `* { box-sizing }` 或 `div { margin: 0 }` 弄歪。
- **z-index 要够高且集中配置。** 挂件被导航栏或弹窗盖住是最常见的投诉，默认给一个很大的值（如 `2147483000`）并且做成配置项而非常量。
- **后端挂了要有降级。** 助手连不上时，界面要给一条人能看懂的错误 + 重试按钮，而不是转圈转到天荒地老。空态、错误态、流式中断三种状态都要实现，不能只做顺利路径。
- **Key 不进前端。** 见上文第 3 问。
- **可访问性不是可选项。** `Esc` 关窗、焦点锁在面板内、`aria-live` 播报新回复、按钮有 `aria-label`、支持 `prefers-reduced-motion`。挂了挂件的页面键盘用户也应该能用。
- **别写描述性文案。** 面板里不需要"这是一个 AI 助手，你可以向它提问"这种废话。给 2–3 个真实的问题示例当入口，比一句说明有用得多。问候语要按用户的业务亲手写，不要用"你好，我是AI助手，很高兴为你服务"这类套话。

## 验证清单

动手交付前逐条实测，并把实测结果写进交付说明（没验过的不要写）：

- [ ] 图标出现在页面上，位置没被遮挡；`z-index` 在真实页面上确认过，不是只在空白页看过。
- [ ] 点开能对话，回复是**流式**出现的（不是憋完一大段才显示）。
- [ ] 点面板以外的地方能收起，而点**面板内部、启动器、历史抽屉内部**不会误关。这条要用**真实鼠标**点一遍——合成事件能验证逻辑，验证不了真实指针路径。
- [ ] 历史 / 新对话 / 记忆按需求生效；`storage` 选对了（`session` 关标签页就清，`local` 跨访问保留）。刷新一次页面确认。
- [ ] 配了热词的话：能拉到；**拉不到时有兜底**，不会变成一片空白。
- [ ] 配了知识库的话：引用能显示出来，链接点得开。
- [ ] 快捷键：`mod+K` 能开合；焦点在**站点自己的输入框**里时不被抢（用真实按键测，合成事件测不出来）。
- [ ] 面板内的文字样式和站点完全一致/完全不冲突：在挂件开启前后各取一次站点某个关键元素的 `getComputedStyle`，对比无变化。
- [ ] 断网或后端 500 时的表现是人话错误 + 重试，不是白屏、不是死转。
- [ ] 移动端（≤400px 宽）能正常用，输入框不被键盘顶掉，面板可关闭。
- [ ] **打包 / SPA 场景**：样式表确实被定位到了。打包后 `script.src` 会变成带哈希的 bundle 名，挂件猜不到同名 `.css`，要显式传 `cssUrl`。没样式的挂件照样"能用"，所以肉眼很容易漏掉。
- [ ] 刷新页面后会话行为符合预期（按需求选可恢复或清零）。
- [ ] 键盘：Tab 能进面板、Esc 能关、焦点不跑到背后的页面上。
- [ ] 跑了 `scripts/verify-embed.mjs`（能扫出占位符没换、域名填错、key 泄漏、init 时机错误）。
- [ ] 删掉挂件相关文件后，站点恢复原状（真的删一次试试）。

## 交付时说什么

一段话讲清四件事，不要写成教程：

1. 加了什么、在哪个文件的哪一行（给路径和行号）。
2. 用户还需要自己做什么（控制台里剩下的步骤、要填的 ID）。
3. 怎么删干净。
4. 实测了哪几条、结果如何。

## 参考文件

- `references/appflow-sdk.md` —— AppFlow Chat SDK 的完整 API（init 参数、setUser/setExtraInfo/onBeforeSend/onAfterSend/close、消息结构）。写 A 路径代码前必读，不要凭记忆写 API。
- `references/console-setup.md` —— 阿里云控制台四步（百炼建应用 → 拿凭证 → AppFlow 建助手 → Web 集成），含 RAG 知识库接法。
- `references/self-hosted-widget.md` —— 自建挂件的架构、传输契约、两个后端代理实现、挂载方式、完整配置表，以及快捷键、provider 预设、记忆/历史、知识库与引用。
- `references/troubleshooting.md` —— 按症状查：request error / Failed to stream content / 图标不出 / 样式打架 / 答不准 / 流式中断。
- `references/design.md` —— 挂件的视觉决策与反"AI 味"清单。
- `assets/appflow-snippet.html` —— A 路径可粘贴模板（含全部常用参数与注释）。
- `assets/embed-selfhosted.html` —— B 路径静态站挂载模板。
- `assets/widget/` —— 零依赖自建挂件源码（JS + CSS + 说明）。
- `scripts/verify-embed.mjs` —— 嵌入配置静态校验器（`bun scripts/verify-embed.mjs <文件或目录>`）。
