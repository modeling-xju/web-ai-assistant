# 自建挂件源码

两个文件，零依赖，直接拷进站点的静态目录：

| 文件 | 大小 | 说明 |
|---|---|---|
| `ai-assistant.js` | ~34 KB | 挂件全部逻辑。含 Shadow DOM 挂载、流式渲染、三个内置 transport |
| `ai-assistant.css` | ~12 KB | 挂件样式。**必须和 JS 放同一目录**——JS 按自己的 `src` 去找同名的 `.css` |

不需要构建步骤，不需要 npm，不需要任何框架。直接 `<script>` 引入即可。

## 30 秒本地验证

不用注册任何账号，也不用后端：

```html
<script src="./ai-assistant.js"
        data-waa
        data-transport="echo"
        data-name="小助"
        data-suggestions="保修怎么查|能开发票吗"></script>
```

`echo` 是一个不发任何网络请求的本地假回复，用来确认挂件本身跑通了、样式没被站点弄歪。
它会逐字吐字，所以流式、光标、停止按钮这些也都能验。

确认没问题后，把 `data-transport` 换成 `openai` 并指向你的后端（见
`references/self-hosted-widget.md` 里的代理实现）。

## 上线前的两件事

1. **把 `echo` 换掉。** 忘了换的话访客会收到假回复。
2. **确认 key 不在前端。** 前端只打你自己的接口，key 在后端。
   `scripts/verify-embed.mjs` 会扫这一类泄漏。

## 兼容性

- 需要 Shadow DOM（Chrome 53+ / Safari 10+ / Firefox 63+ / Edge 79+）。
  不支持时会退化成普通 DOM 挂载——能用，但样式不再隔离。
- 需要 `fetch` + `ReadableStream`（同样的浏览器范围）。
- 没有用到任何构建期语法，老一点的打包器也不需要额外配置。
