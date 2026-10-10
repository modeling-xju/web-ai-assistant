---
name: web-ai-assistant
description: Embed an AI assistant into a website (floating chat widget / AI customer support / site Q&A bot / website chat widget / embedded AI assistant / chatbot bubble). Covers both routes — the official Alibaba Cloud Bailian + AppFlow floating widget (AppflowChatSDK), and a zero-dependency self-hosted widget (Shadow DOM isolation, SSE streaming, swappable backend adapter). Also use it to debug a widget that is already embedded but broken — a conversation that reports request error, Failed to stream content, an icon that never renders, styles polluting each other with the host site, an API Key leaked into the frontend, a knowledge base that answers inaccurately. Use this skill whenever the user mentions 「AI 助手」「AI 客服」「智能客服」「在线客服」「聊天挂件」「悬浮窗」「右下角客服」「网站问答」「知识库问答」「百炼」「AppFlow」「智能体应用」「embedded assistant」「chat widget」「support bubble」 — even when they never say the word widget, even when all they say is 「想让网站能回答访客的问题」.
---

# Embed an AI assistant into a website

Hang a conversational AI assistant onto a site the user already has, **without breaking the site they already have.**

"Embedded" carries three meanings here, and skipping any one of them means you did not deliver:

1. **It comes up** — a visitor can see the entry point on the page, open it, type, and get a reply.
2. **It doesn't fight** — the widget's styles and scripts must not pollute the site, and the site's styles and scripts must not break the widget.
3. **It can be re-plumbed** — the model vendor, the backend URL, the keys: everything that will change tomorrow must not be welded into the code.

## Settle three questions before you touch code

Don't skip this and go straight to writing code. These three answers determine 90% of the implementation that follows, and guessing wrong wastes the whole job:

1. **Which route?** See the decision table below. If the user already mentioned Bailian / AppFlow / an agent app, default to A. If they have no Alibaba Cloud account, are developing locally, or need private deployment, take B.
2. **What shape is the site?** Plain static HTML / a Vite-Webpack SPA / a Vue-React component tree / server-side templates (JSP-PHP-Django). This decides which file those "few lines of code" go into, and whether the widget can be an ES module.
3. **Who pays for the model, and where does the key live?** This is the one security item you **must** be strict about:
   - The user already has a backend → key on the backend, the frontend only calls their own endpoint.
   - The user only has static hosting (GitHub Pages / OSS / CDN) → either add a razor-thin proxy (cloud function / serverless / Nginx), or use AppFlow's integration ID (it is a public identifier built for frontend use to begin with).
   - The user insists on putting the key in the frontend → **tell them plainly that this publishes the key**, then do what they asked, but leave one line of risk record in the handoff notes. Don't do it quietly, and don't refuse the job over it either.

## Decision table

| Situation | Route | Read |
|---|---|---|
| Already has a Bailian app + AppFlow integration ID, wants results fastest | **A** official floating widget | `references/appflow-sdk.md` |
| Has a Bailian app only (app ID + API Key), no AppFlow | **B** self-hosted widget + Bailian-compatible mode | `references/self-hosted-widget.md` |
| No LLM account at all, or needs to run locally / deploy privately / swap in an in-house model | **B** self-hosted widget + your own adapter | `references/self-hosted-widget.md` |
| Already embedded, but broken | Read `references/troubleshooting.md` to locate it, then go back to the matching route | `references/troubleshooting.md` |
| Wants to feed company docs to the assistant (RAG) | Orthogonal to A/B — either route can carry it | `references/console-setup.md` step 4 |

## Path A: the official AppFlow floating widget

The AppFlow widget is **one external SDK plus one init config**, hosted by the vendor on `o.alicdn.com`, which makes it safe for the frontend (the frontend only exposes `integrateId` and `requestDomain`, never the API Key).

**A1 · Have the user finish four things in the console** (you can't click through the console for them — hand this step over with a checklist they can follow):

1. 百炼控制台 (Bailian console) → 应用管理 (App Management) → create an **智能体应用 (Agent App)** → write the role Prompt → publish.
2. Copy down the **应用 ID (app ID)**; create an **API Key** under 密钥管理 (API Key Management).
3. AppFlow console → 模型服务 (Model Service) → **AI 助手 (AI Assistant)** → create → **导入模型 (Import Model)** (pick Alibaba Cloud Bailian, fill in the API Key + app ID).
4. AI Assistant detail → 页面集成 (Web Integration) → **创建集成 (Create Integration)** (this is where you tune font color, avatar, and preset questions) → submit.

The full step-by-step write-up — where each control sits on the page, and the places people fill in wrong — is in `references/console-setup.md`.

**A2 · Get three things in hand before you touch code**: `integrateId`, `requestDomain` (shaped like `https://xxx.appflow.aliyunnest.com`), and the auth method selected under 登录配置 (Login Configuration) in the web integration. **Never invent a `requestDomain`** — making one up is the standard cause of `Failed to stream content`.

**A3 · Paste the code into the site.** A ready-to-use template lives at `assets/appflow-snippet.html`; read it and adapt it. The insertion rules that matter:

- Put both `<script>` tags before `</body>`; **don't** drop them in `<head>` and block first paint, and **don't** put them inside an SPA component that only mounts once (that double-inits).
- Give the `<script>` that loads the SDK `defer`, and place the init one after it. (Does an inline script naturally run after a deferred script? No — the inline script runs first. So the init has to be wrapped in `window.addEventListener('load', …)`, or driven by the deferred script's load callback. This is the most common cause of "the widget shows no icon".)
- Run `scripts/verify-embed.mjs` once before you hand anything over.

**A4 · Add configuration as needed**: `draggable` / `autoOpen` / `initialMessage` / `customStyle` / `setUser` / `setExtraInfo` / `onBeforeSend` / `onAfterSend` / `close`. Exact types and semantics for each parameter are in `references/appflow-sdk.md` — **don't guess at the API**.

**A5 · Feed the site's context to the assistant** (enormous value, and the step people skip most often). Use `setExtraInfo` to pass in which page the visitor is on right now, which product they're looking at, whether they're a signed-in user — that's what lets the assistant answer concretely:

```js
window.APPFLOW_CHAT_SDK.setExtraInfo({
  currentPage: location.pathname,
  pageTitle: document.title,
  productId: new URLSearchParams(location.search).get('id') || undefined,
}, true);   // isGlobal=true: every message after this one carries it
```

## Path B: the self-hosted widget

Take this one when there is no AppFlow, when private deployment is required, when you need to verify things locally, or when you're connecting an in-house model.

**B1 · Copy the widget.** `assets/widget/` holds two zero-dependency files (`ai-assistant.js` + `ai-assistant.css`) — copy them into the site's static directory. It locks its styles entirely inside its own Shadow DOM and can't pollute the site — that's what makes the self-hosted route able to "not fight", so don't rewrite it as a plain div.

**B2 · Write the backend proxy.** This is the real work on the self-hosted route, and the only place a key can safely live. Take care **not to scatter LLM protocols into the frontend**: the frontend recognizes exactly one contract — `{messages} → SSE text stream` — and swapping models touches the backend only. `references/self-hosted-widget.md` has a drop-in FastAPI version and a drop-in Node version, plus both the Bailian-compatible mode and the agent-app upstream style.

**B3 · Mount it.** Static sites auto-mount from `data-*` attributes (see `assets/embed-selfhosted.html`); in an SPA, call `WebAIAssistant.mount({...})` once, after the root component mounts.

**B4 · Re-skin it.** The default palette is driven by CSS custom properties (`--waa-accent` / `--waa-bg` / `--waa-ink` / `--waa-radius` …) — change a few variables and it blends into the site. Before you touch how it looks, read `references/design.md`: it explains why this widget looks the way it does, and which moves make a component read as "AI-generated" at a glance.

**B5 · Don't rebuild these wheels.** The widget already ships everything below, so when a user asks for one of these it's a **configuration** question, not a development question:

| What the user says | What you do |
|---|---|
| 「点别处要能收起」 (clicking elsewhere should collapse it) | On by default (`closeOnOutsideClick`). Only touch the config to turn it off |
| 「要有历史记录 / 新对话」 (keep history / a new-chat button) | Already there by default (`history: true`). To keep it across visits, set `storage` to `'local'` |
| 「要能记住用户」 (remember the visitor) | Write with `widget.remember({...})`; it rides along on every request automatically. Store stable facts, not transient state |
| 「要热词 / 热门问题」 (hot words / popular questions) | `hotWords` as the static fallback plus `hotWordsUrl` to pull them from your backend (`{items:[...]}`), see `references/self-hosted-widget.md` |
| 「要接知识库 / 要能引用资料」 (hook up a knowledge base / cite sources) | The widget **displays** citations and **passes the config down**; retrieval happens in your own backend. See the 知识库与引用 (Knowledge base and citations) section of `self-hosted-widget.md` |
| 「要能按快捷键唤起」 (open it with a keyboard shortcut) | Already there: `mod+K` toggles, `mod+/` shows the shortcut sheet, `Alt+↑↓` switches conversations. To rebind, pass `hotkeys`; to disable the whole set, pass `shortcuts: false` |
| 「直接接某家大模型 API」 (talk straight to some vendor's LLM API) | Use a `provider` preset (OpenAI / 百炼 (Bailian) / DeepSeek / Kimi / GLM / SiliconFlow / OpenRouter / Ollama / vLLM / Anthropic). **But settle where the key goes first** — see below |

**On `provider`: ask about the key before you write code.** If the user is building a public website, writing `provider` + `apiKey` straight into the page publishes the key.
The right line here is "预设我可以用，但 key 得放后端，前端打你自己的接口" ("I can use the preset, but the key has to live on the backend — the frontend calls your own endpoint"), and then hand them the skeleton for a backend proxy
(`self-hosted-widget.md` has both the FastAPI and the Node version under 后端代理 (backend proxy)).
Only local development, an intranet, or a keyless setup like Ollama may connect directly.

Before you write code, confirm that none of this actually already satisfies the need — rewriting capabilities that already exist is the most common waste on this route.

## Hard constraints shared by both routes

These are not style preferences; they're the potholes that cost the most rework:

- **Add, never rewrite.** The user asked for "add an assistant", not "rewrite my website". Don't refactor existing functions, don't change existing interfaces or data structures, don't touch the build config. The widget should be something you can **add and then delete cleanly** — tell the user at handoff that "delete these two lines / these two files and everything is back to how it was".
- **Styles must be isolated.** Shadow DOM or iframe — pick one. Drop a div with global class names straight into `document.body` and sooner or later some page's `* { box-sizing }` or `div { margin: 0 }` will bend it out of shape.
- **z-index has to be high, and configured in one place.** The widget getting buried under a nav bar or a modal is the single most common complaint. Default it to something huge (like `2147483000`) and make it a config option rather than a constant.
- **A dead backend needs a fallback.** When the assistant can't connect, the UI owes the visitor a human-readable error and a retry button, not a spinner that spins forever. Empty state, error state, and interrupted stream all need implementing — the happy path alone isn't delivery.
- **The key never enters the frontend.** See question 3 above.
- **Accessibility is not optional.** `Esc` closes the panel, focus stays trapped inside it, `aria-live` announces new replies, buttons carry `aria-label`, `prefers-reduced-motion` is honored. A page with the widget on it has to be usable by keyboard users too.
- **Don't write descriptive copy.** The panel doesn't need filler like "This is an AI assistant, you can ask it questions". Two or three real example questions as entry points beat a line of explanation by a mile. Write the greeting by hand against the user's actual business — no boilerplate like "你好，我是AI助手，很高兴为你服务" ("Hi, I'm an AI assistant, happy to help").

## Verification checklist

Test every line below for real before you deliver, and put the results in your handoff notes (never write down anything you didn't verify):

- [ ] The icon appears on the page and nothing covers it; `z-index` was confirmed **on the real page**, not just on a blank test page.
- [ ] Clicking it opens a working conversation, and replies arrive **streamed** (not one big blob after a long pause).
- [ ] Clicking outside the panel collapses it, while clicking **inside the panel, on the launcher, or inside the history drawer** doesn't close it by mistake. Walk this one with a **real mouse** — synthetic events verify the logic, not the real pointer path.
- [ ] History / new chat / memory behave as required, and `storage` is the right choice (`session` clears when the tab closes, `local` survives across visits). Reload once to confirm.
- [ ] If hot words are configured: they load, **and there's a fallback when they don't**, so the panel never goes blank.
- [ ] If a knowledge base is configured: citations render and their links open.
- [ ] Shortcuts: `mod+K` toggles; the key is **not** stolen while focus is in **the site's own input** (test with real key presses — synthetic events won't catch this).
- [ ] Text styles inside the panel match the site exactly or don't conflict at all: sample `getComputedStyle` on one key site element before and after the widget appears, and diff them — no change.
- [ ] Offline, or a 500 from the backend, shows a human-readable error plus retry — not a blank screen, not an endless spinner.
- [ ] It works on mobile (≤400px wide), the input isn't shoved off by the keyboard, and the panel can be closed.
- [ ] **Bundled / SPA case**: the stylesheet really did get located. After bundling, `script.src` becomes a hashed bundle name, so the widget can't guess a same-named `.css` — pass `cssUrl` explicitly. An unstyled widget still "works", which is exactly why the eye misses it.
- [ ] After a page reload the conversation behaves the way the requirement says (restored or cleared, whichever was asked for).
- [ ] Keyboard: Tab reaches the panel, Esc closes it, focus doesn't escape onto the page behind.
- [ ] `scripts/verify-embed.mjs` was run (it catches unreplaced placeholders, a wrong domain, a leaked key, and bad init timing).
- [ ] Delete the widget-related files and the site is back to how it was — actually delete them once and see.

## What to say when you deliver

One passage, four things, and no tutorial:

1. What you added, in which file and at which line (give paths and line numbers).
2. What the user still has to do themselves (the remaining console steps, the IDs to fill in).
3. How to remove it cleanly.
4. Which checks you actually ran, and what they showed.

## Reference files

- `references/appflow-sdk.md` — the complete AppFlow Chat SDK API (init options, setUser/setExtraInfo/onBeforeSend/onAfterSend/close, message shapes). Required reading before you write Path A code; don't write the API from memory.
- `references/console-setup.md` — the four Alibaba Cloud console steps (create a 百炼 (Bailian) app → grab credentials → create an AppFlow assistant → web integration), including how to wire up a RAG 知识库 (Knowledge Base).
- `references/self-hosted-widget.md` — the self-hosted widget's architecture, transport contract, two backend proxy implementations, mounting, the full config table, plus shortcuts, provider presets, memory/history, and the knowledge base with citations.
- `references/troubleshooting.md` — symptom-first lookup: request error / Failed to stream content / icon never renders / styles fighting / inaccurate answers / interrupted stream.
- `references/design.md` — the widget's visual decisions and the anti-"AI smell" checklist.
- `assets/appflow-snippet.html` — the paste-ready template for Path A (all common parameters and comments included).
- `assets/embed-selfhosted.html` — the mounting template for Path B on a static site.
- `assets/widget/` — the zero-dependency self-hosted widget source (JS + CSS + docs).
- `scripts/verify-embed.mjs` — static checker for embed configuration (`bun scripts/verify-embed.mjs <文件或目录>`, i.e. a file or a directory).
