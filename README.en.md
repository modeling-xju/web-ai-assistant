# web-ai-assistant

**Embed an AI assistant into a website.** Two routes: the official floating widget from **Alibaba Cloud Bailian + AppFlow**, or a **zero-dependency self-hosted widget** (Shadow DOM isolation, SSE streaming, swappable backend adapter).

This is an **Agent Skill** (a skill pack for AI coding assistants) — or you can just take the widget source out of it and use that on its own.

[中文](README.md) · [English](README.en.md) · **Live demo → https://modeling-xju.github.io/web-ai-assistant/**

<img src="docs/hero.svg" alt="Widget motion demo: expand, ask a question, watch the answer stream in, see sources and hot words, then click empty space to collapse" width="800">

*Expand → ask → streamed answer → sources and hot words → click empty space to collapse. Open the [live demo](https://modeling-xju.github.io/web-ai-assistant/) and play with it yourself.*

---

## What it solves

This skill grew out of Alibaba Cloud's tutorial 《在网站上增加一个 AI 助手》 ("Adding an AI assistant to a website"). That tutorial is a 4-step chain (create a Bailian app → grab credentials → create an AppFlow assistant → embed it in the site), but **very little of it can actually be automated** — someone has to click through the console, and everything left over is the job of "pasting code into your site", which is precisely the part that goes wrong most often:

| How it typically goes wrong | What you get |
|---|---|
| You add `defer` to the SDK and put `init` in an inline script | `APPFLOW_CHAT_SDK is undefined`, and the widget never appears at all |
| You copy the `/chat` from an example into `requestDomain` | `Failed to stream content` the moment a message is sent |
| You drop a div with global class names straight into `body` | Widget and site styles pollute each other, and it's hard to reproduce |
| You put the API Key in the frontend | A static page is public, so the key is public |
| You `init` inside an SPA component | Navigate back and forth and you end up with several icons |
| The stylesheet can't be found after bundling | The widget renders as unstyled bare HTML |
| The hotkey steals the site search box's `Ctrl+K` | "你们的挂件把我网站弄坏了" ("your widget broke my website") |

This skill folds all of it into the workflow, the checker, and the widget implementation itself.

## The two routes

<img src="docs/paths.svg" alt="Two integration routes: A talks to Bailian directly through the AppFlow-hosted widget; B is a self-hosted widget that goes through your own backend proxy to any LLM" width="820">

**Path A · the official AppFlow floating widget** — take this when a Bailian app and an AppFlow integration already exist. The frontend only exposes `integrateId` and `requestDomain`; the API Key never lands there.
→ `references/appflow-sdk.md` (the complete SDK API), `references/console-setup.md` (the four console steps)

**Path B · the self-hosted widget** — take this when there is no Alibaba Cloud account, when private deployment is needed, when you're connecting an in-house model, or when you'd rather get it working locally first. Two zero-dependency files, styles running inside Shadow DOM, and a UI that depends on one contract only: `transport`.
→ `references/self-hosted-widget.md`

## What the widget ships with

The widget on the self-hosted route is **deliverable as-is**, not "a chat bubble skeleton":

| Capability | What it does |
|---|---|
| **Close on outside click** | Click anywhere outside the panel to collapse it; clicks inside the panel, on the launcher, or inside the history drawer never close it by mistake. The site's own overlays can be exempted with `outsideIgnore` |
| **Hotkeys** | `Ctrl/⌘ + K` toggles, `Ctrl/⌘ + /` opens the shortcut sheet, `Alt + ↑↓` switches conversations, `↑` recalls your previous question. It **doesn't steal the key** while focus is in the site's own input. Everything is rebindable |
| **Multiple conversations** | A **New chat** button plus a history drawer: switch, delete, clear. Three storage modes: `session` / `local` / `none` |
| **Memory** | Stable facts about the visitor are persisted and attached automatically as a system message on every request; visible in the drawer, clearable in one click |
| **Hot words** | A static fallback plus a fetch from your backend (`hotWordsUrl`), with heat counts, optionally pinned above the input |
| **Direct LLM API** | 11 provider presets (OpenAI / 百炼 (Bailian) / DeepSeek / Kimi / GLM / SiliconFlow / OpenRouter / Ollama / vLLM / Anthropic). Anthropic goes through its own protocol adapter |
| **Knowledge base citations** | Recognizes `references` / `citations` / `sources` / `search_info` / `doc_references` automatically and renders them as an expandable 参考资料 (Sources) block; also supports a `retrieve` frontend retrieval hook |
| **Style isolation** | Two-way Shadow DOM isolation. Even if the site writes `* { box-sizing: content-box }` or `div { border: 2px dashed }`, none of it gets in |
| **Streaming + fallback** | Token-by-token SSE, interruptible; a dead backend gives you a human-readable error and a retry, not a blank screen and an endless spinner |
| **Accessibility** | Esc closes, focus management, `aria-live` announcements, `prefers-reduced-motion` |

The palette runs on CSS custom properties — change four variables and it fits any site. Retrieval itself is not implemented: the widget **passes the knowledge base config down** and **displays the documents that matched**; the retrieval happens in your own backend.

## How to use it

### Install it as a skill

Drop it into your skills directory (Cherry Studio picks it up automatically):

```
<your-skills-dir>/web-ai-assistant/
├── SKILL.md
├── references/
└── assets/ · scripts/ · evals/
```

Once it's installed, just say 「帮我把 AI 助手加到我们官网上」 ("add an AI assistant to our official site") or 「网站上的 AI 客服报 Failed to stream content」 ("the AI support bot on our site reports Failed to stream content") and it will follow this workflow.

### Just want the widget source

```html
<script src="./ai-assistant.js"
        data-waa
        data-transport="echo"
        data-name="小助"
        data-hot-words="保修怎么查|能开发票吗"
        data-suggestions="多久到货|支持退换吗"></script>
```

`data-transport="echo"` is a local fake reply that **fires no network request at all** — use it to confirm the widget is wired up and that the site hasn't bent its styles. Once that looks right, connect a real model:

```html
<!-- local development / intranet / keyless setups like Ollama -->
<script src="/static/ai-assistant.js"
        data-waa
        data-provider="deepseek"
        data-model="deepseek-chat"></script>
```

Or mount it from JS, which takes the fuller config:

```js
WebAIAssistant.mount({
  provider: 'dashscope',          // provider preset
  model: 'qwen-plus',
  name: '小助',
  greeting: '想了解哪一款？',
  hotWordsUrl: '/api/hot-words',  // pull hot words from the backend
  knowledge: { id: 'kb_1', topK: 4 },
  shortcuts: true
});
```

### ⚠ Putting the key in the browser is publishing it

The snippets above are only for **local development, an intranet, or keyless setups like Ollama**. Put them on a public site and any visitor can press F12 and walk off with your key. In production there is exactly one shape:

```
browser  ──►  your own backend (the key lives here)  ──►  LLM API
```

The backend only has to translate `{messages}` into the upstream protocol and pipe the SSE straight back. Two working implementations, FastAPI and Node, are in `references/self-hosted-widget.md`.

## The checker

Run it once before you deliver — it catches unreplaced placeholders, a domain left as a relative path, bad `init` timing, a leaked key, and a stylesheet that never got copied:

```bash
bun scripts/verify-embed.mjs ./your-site           # human-readable
bun scripts/verify-embed.mjs ./your-site --json    # machine-readable; exit code 1 when there are errors
```

## Layout

```
SKILL.md                          Agent workflow and constraints (中文 / Chinese original)
SKILL.en.md                       English version of SKILL.md
README.md / README.en.md          Chinese and English guides
index.html                        live demo (which is itself a usage example)
hot-words.json                    hot-word data used by the demo
docs/
  hero.svg                        motion demo (pure SVG + CSS animation, no JS)
  paths.svg                       the two integration routes
references/
  appflow-sdk.md                  complete AppFlow Chat SDK API
  console-setup.md                the four Alibaba Cloud console steps + knowledge base (RAG)
  self-hosted-widget.md           architecture, transport contract, backend proxy, hotkeys, providers, memory/history, RAG
  troubleshooting.md              symptom-first troubleshooting
  design.md                       visual decisions and the anti-"AI smell" checklist
assets/
  appflow-snippet.html            paste-ready template for Path A
  embed-selfhosted.html           mounting template for Path B
  widget/                         self-hosted widget source (JS + CSS)
scripts/
  verify-embed.mjs                static checker for embed configuration
evals/
  evals.json                      eval cases
  fixtures/                       sample sites used by the evals
```

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl/⌘ + K` | Open / collapse the assistant |
| `Ctrl/⌘ + /` | Shortcut sheet |
| `Ctrl/⌘ + Shift + H` | History and memory |
| `Ctrl/⌘ + Shift + O` | New conversation |
| `Esc` | Collapse (closes the drawer first if one is open) |
| `Alt + ↑` / `Alt + ↓` | Previous / next conversation |
| `Enter` / `Shift + Enter` | Send / newline |
| `↑` | Recall your previous question (when the input is empty) |

Rebind: `hotkeys: { toggle: 'mod+shift+k', newChat: false }`; disable the whole set: `shortcuts: false`.

**The widget never touches the clipboard keys.** Copy (`Ctrl/⌘+C`), cut (`+X`), paste (`+V`), select-all (`+A`) and undo (`+Z`) are left to the OS and the browser — the widget neither binds nor intercepts them. Conversely, binding one of those combos to a widget action is **rejected with a warning** and falls back to the default: a chat widget breaking the user's `Ctrl+C` is a far worse accident than missing one shortcut. Reply text stays selectable, and code blocks get their own copy button (which falls back to `execCommand` on plain-http intranet hosts).

## Design stance

The widget's default look deliberately dodges the category clichés — the blue-purple gradient orb, the fat rounded bubble, the stacked shadows. It goes for ink and paper instead: hairline borders in place of shadows, color reserved exclusively for "generating" and unread indicators, and a vertical rule instead of a bubble on the assistant's side.

Why it's built this way, and which moves make something look assembled from parts at a glance, is written up in `references/design.md`.

## License

MIT
