# web-ai-assistant

给网站内嵌一个 AI 助手。覆盖两条路：接**阿里云百炼 + AppFlow** 的官方悬浮挂件，或用**零依赖自建挂件**（Shadow DOM 隔离、SSE 流式、后端 adapter 可替换）。

这是一个 **Agent Skill**（给 AI 编码助手用的技能包），也可以只把里面的挂件源码拿去自己用。

**👉 [打开在线演示](https://modeling-xju.github.io/web-ai-assistant/)** —— 不用配后端，打开就能玩。

---

## 它解决什么

这个 skill 是从阿里云那篇《在网站上增加一个 AI 助手》的教程演化来的。原教程是一条 4 步链路（百炼建应用 → 拿凭证 → AppFlow 建助手 → 挂到网站），但**教程里真正能自动化执行的部分很少**——控制台得人点，剩下的全是"往你站里插代码"这件事，而恰恰是这件事最容易出错：

| 常见翻车 | 后果 |
|---|---|
| SDK 加 `defer`，`init` 写在内联脚本里 | `APPFLOW_CHAT_SDK is undefined`，挂件根本不出来 |
| `requestDomain` 抄了示例里的 `/chat` | 一发消息就 `Failed to stream content` |
| 直接往 `body` 塞带全局类名的 div | 挂件与站点样式互相污染，还很难复现 |
| 把 API Key 写进前端 | 静态页面是公开的，等于公开密钥 |
| SPA 里在组件内 `init` | 路由来回，挂出好几个图标 |
| 打包后样式表找不到 | 挂件渲染成没有样式的裸 HTML |

这个 skill 把这些都写进了流程和校验器里。

## 挂件自带什么

自建路径的挂件是**能直接交付**的，不是"一个聊天气泡的骨架"：

| 能力 | 说明 |
|---|---|
| **点外部收起** | 点面板以外的任何地方收起；面板内部、启动器、历史抽屉内部不会误关。Esc 同样有效，抽屉打开时 Esc 先关抽屉。站点自己的弹层可以放进 `outsideIgnore` 豁免 |
| **多会话历史** | 「新对话」+ 历史抽屉：切换、删除、清空。可选 `session`（关标签页清）/ `local`（跨访问保留） |
| **记忆** | 关于访客的稳定事实（门店、机型、偏好…）持久保存，每次请求自动作为 system 消息带上；抽屉里可见、可一键清空 |
| **热词** | 静态兜底 + 从后端拉取（`hotWordsUrl`），带热度数字，可设为常驻在输入框上方 |
| **知识库引用** | 自动识别 `references` / `citations` / `sources` / `search_info` / `doc_references` 等常见字段，渲染成可展开的「参考资料」；也支持 `retrieve` 前端检索钩子 |
| **样式隔离** | Shadow DOM，双向隔离。站点写 `* { box-sizing: content-box }`、`div { border: 2px dashed }` 也进不来 |
| **流式 + 降级** | SSE 逐字流式、可中断；后端挂了给人话错误 + 重试，不是白屏死转 |
| **可访问性** | Esc 关窗、焦点管理、`aria-live` 播报、`prefers-reduced-motion` |

配色走 CSS 自定义属性，改四个变量就能融进任何站点。检索本身不实现——挂件负责**下发知识库配置**和**显示命中的资料**，检索在你自己的后端做。

## 两条路

**路径 A · 官方 AppFlow 悬浮挂件**
你已经有百炼应用和 AppFlow 集成时走这条。`integrateId` + `requestDomain` 是唯一暴露在前端的东西，API Key 不落地，最省事。
→ 见 `references/appflow-sdk.md`（SDK 完整 API）、`references/console-setup.md`（控制台四步）

**路径 B · 自建挂件**
没有阿里云账号、要私有部署、要接自研模型、或者想先在本地跑通时走这条。`assets/widget/` 是两个零依赖文件，样式跑在 Shadow DOM 里，界面只依赖一个 `transport` 契约，换模型只改后端。
→ 见 `references/self-hosted-widget.md`（含 FastAPI / Node 两个代理实现）

## 怎么用

### 作为 skill 安装

放到你的技能目录即可（Cherry Studio 会自动识别）：

```
<技能库>/web-ai-assistant/
├── SKILL.md
├── references/
└── assets/ · scripts/ · evals/
```

装好后，直接跟助手说「帮我把 AI 助手加到我们官网上」「网站上的 AI 客服报 Failed to stream content」，它就会走这套流程。

### 只要挂件源码

```html
<script src="./ai-assistant.js"
        data-waa
        data-transport="echo"
        data-name="小助"
        data-suggestions="保修怎么查|能开发票吗|多久到货"></script>
```

`data-transport="echo"` 是**不发任何网络请求**的本地假回复，用来确认挂件本身跑通了、样式没被站点弄歪。确认无误后换成 `openai` 并指向你自己的后端：

```html
<script src="/static/ai-assistant.js"
        data-waa
        data-transport="openai"
        data-endpoint="/api/assistant/chat"
        data-model="qwen-plus"></script>
```

两个文件必须放同一目录（JS 按自己的 `src` 去找同名 `.css`）。

## 校验器

交付前跑一遍，能扫出占位符没换、域名填成相对路径、`init` 时序错、密钥泄漏、样式表漏拷：

```bash
bun scripts/verify-embed.mjs ./你的站点           # 人类可读
bun scripts/verify-embed.mjs ./你的站点 --json    # 机器可读，有 error 时退出码 1
```

## 目录

```
SKILL.md                          Agent 的执行流程与约束
index.html                        在线演示（这个页面本身就是一份用法示例）
hot-words.json                    演示用的热词数据（模拟后端返回）
references/
  appflow-sdk.md                  AppFlow Chat SDK 完整 API
  console-setup.md                阿里云控制台四步 + 知识库（RAG）
  self-hosted-widget.md           自建挂件架构、传输契约、后端代理实现、记忆/历史/热词/RAG
  troubleshooting.md              按症状排查
  design.md                       挂件的视觉决策与反"AI 味"清单
assets/
  appflow-snippet.html            路径 A 可粘贴模板
  embed-selfhosted.html           路径 B 挂载模板
  widget/                         自建挂件源码（JS + CSS）
scripts/
  verify-embed.mjs                接入配置静态校验器
evals/
  evals.json                      三个评测用例
  fixtures/                       评测用的站点样本
```

## 设计取向

挂件的默认外观刻意避开了「蓝紫渐变圆球 + 大圆角气泡 + 层层阴影」这套品类陈词。改用墨与纸的取向：发丝级描边代替阴影，唯一的彩色只出现在"正在生成"和未读提示上，助手侧不用气泡而用一条竖线起头。配色走 CSS 自定义属性，改四个变量就能融进任何站点。

为什么这么做、以及哪些做法会让它一眼看出是拼出来的，写在 `references/design.md`。

## 许可

MIT
