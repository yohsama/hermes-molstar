# Mol* 打包为 Hermes 插件：可行性评估

## 结论

可行，建议做成独立的 Mol* 预览插件，而不是修改 Hermes 的 React 依赖或把整个 Mol* 应用塞入聊天 Markdown。推荐“薄 Desktop 壳 + 打包的 Mol* viewer + 小型文件读取后端”。先实现插件自己的查看面板和聊天入口；点击普通 `.pdb/.cif` 文件自动接管预览，是另外一个接入问题。

本次只核对官方资料、本机源码和真实 npm 发布包；没有安装插件、修改 Hermes 核心或运行当前 Electron 的 WebGL 验收。以下架构是建议，不是已经完成的功能。

## 已核实的基础

- Mol* 官方提供可嵌入的 `Viewer` 及 `build/viewer/molstar.js`、`molstar.css`，无需重写分子解析与可视化。[6]
- 实检 npm `molstar@5.13.1` 发布包：`molstar.js` 为 5,268,685 字节，CSS 为 72,904 字节；类型声明包含 `loadStructureFromData(data, format, options)` 与 `dispose()`。许可证为 MIT，分发时需保留相应许可声明并核查依赖 notices。[12][13]
- Hermes Desktop 支持插件面板、页面、命令以及 `TRANSCRIPT_DIRECTIVE_AREA`，因此可以用“打开结构”命令与聊天中的专用指令作为入口。[2]
- Hermes 的 `SandboxedFrame` 允许脚本运行，但保持不透明 origin，只接收绝对 HTTP(S) 或 data URL；不能直接加载 `file:`/`blob:`/相对地址，也不能开放 `allow-same-origin`。[2]

## 推荐实现

### 对用户的入口

1. 可复用的右侧 Mol* 面板，提供打开文件、最近文件、显示模式与复位相机。
2. 手动选择或拖入本机 PDB/mmCIF 文件。
3. agent 给出路径后，渲染插件专用聊天卡片，例如 `::molstar{file="results/model.pdb"}`；点击后在同一个面板打开，而不是每条消息都创建一个 WebGL 实例。

指令名称、面板 UI 及工具名称均为拟议设计，当前尚未注册。

### 组件分工

- **Desktop 壳**：使用 Hermes SDK 注册 pane、命令、聊天 directive，维护当前会话/文件的轻量状态，负责主题和生命周期。
- **Mol* viewer**：锁定已验证版本，预打包 JS/CSS/必要资源。优先保留结构、序列、选中/聚焦和常用表示；默认关闭与本地预览无关的远程获取、远程状态与密度流请求。
- **文件后端**：通过插件自己的 `ctx.rest` namespace，返回经过验证的完整结构内容与元数据；显式校验路径、当前 workspace/授权范围、格式和文件大小。不要通过普通文本预览 API 取完整 PDB。
- **沙箱桥接**：后端可把自包含 viewer 文档包装为 JSON 字段，Desktop 壳读取后通过 data URL 交给 `SandboxedFrame`。PDB 内容经校验的 `postMessage` 传入，不让 iframe 自行访问磁盘、持有网关凭证或依赖跨域鉴权。验证消息来源、schema 和每实例 nonce；不透明 origin 下不要只依赖 `event.origin`。

该方案不要求额外启动独立 localhost HTTP 服务，复用 Hermes 已有插件 API 即可；实际是否需要额外静态资源端点，应由构建产物检查决定。字体、worker、WASM 等不能遗留成无法解析的相对资源。

## 当前 Hermes 的真实边界

本机源码根：`C:/Users/yoh_s/AppData/Local/hermes/hermes-agent`。

### 不能直接按普通前端项目导入

Desktop 运行时入口只允许 SDK 与 React 的受限 import；不能在 `plugin.js` 中直接 `import 'molstar'`、相对 JS 或 CSS。需要发布前完成 vendor bundling。[2]

证据：
- `apps/desktop/src/contrib/runtime-loader.ts:332–418`
- `apps/desktop/src/sdk/runtime.ts:60–67`

### 完整文件读取不能复用被截断的文本预览

当前 `hermes:readFileText` 预览读取会在 512 KiB 截断。专用插件源码读取上限则为 16 MiB。大结构解析必须使用完整读取路径，不能把“预览成功”当作“完整文件已取到”。

证据：`apps/desktop/electron/main.ts:17789–17847`。

`ctx.os.pickOpenPath` 提供本机文件选择；连接远程 gateway 时，本机对话框选出的路径不能直接当成远端路径。`ctx.rest` 支持 JSON-oriented 请求及 multipart 上传，可用于明确区分本机上传与后端路径读取。

证据：
- `apps/desktop/src/contrib/plugin.ts:76–109`
- `apps/desktop/src/api/plugins.ts:42–86`

### 安装插件不等于自动接管 .pdb

在本版 SDK、贡献系统和文件预览实现的检查范围内，没有找到按扩展名/MIME 注册文件预览 provider 的公开入口。现有文件预览类型归类是固定分支，普通 PDB/CIF 会走文本路径。

因此：
- 插件自己的面板、命令与聊天入口：不需要改核心。
- 普通文件卡片/文件树点击 `.pdb` 后直接显示 Mol*：应单独增加一个窄的核心 file-preview provider 接口或分派接入点；不要通过修改核心 DOM 点击监听来伪装插件能力。

证据：
- `apps/desktop/src/lib/local-preview.ts:249–265`
- `apps/desktop/electron/main.ts:6083–6105`
- `apps/desktop/src/app/chat/right-rail/preview-pane.tsx:1551–1560`

## 风险与验收

1. **WebGL 实机兼容**：在当前 Windows/Electron 内验证渲染、旋转缩放、面板 resize 与 context loss；文档和源码审查不能替代 GPU 验收。
2. **离线与资源完整性**：断网打开本地 PDB/mmCIF，确认没有 CDN、相对资源失败或非必要远程查询。
3. **完整读取**：至少覆盖超过 512 KiB 的结构、损坏文件与超限文件；拒绝或清楚报告失败，不静默显示截断结果。
4. **生命周期与性能**：关闭面板、切换文件、热重载和禁用插件后清理 viewer、订阅及 GPU 资源。聊天卡片按需打开可复用 viewer，避免大量常驻 WebGL 实例。
5. **路径与 profile**：本机文件、backend 工作区文件和远程 gateway 文件分开处理；不要依赖 Desktop UI 与 gateway 永远处于同一主机或 profile。
6. **分发要求**：本地运行可行不代表插件目录审核必然通过。Desktop admission lint 会检查脚本注入、动态求值等模式；应审查薄壳与受控 viewer 资源的正式分发方式，而不是规避检查。

目录检查证据：`hermes_cli/plugin_validate_desktop.py:16–35`。

## 建议的首版范围

只做 PDB/mmCIF 完整加载、旋转缩放、cartoon/ball-and-stick、链/残基选择、聚焦、相机复位和截图；先不做轨迹、多模型批量比较或计算分析。以“手动打开 + agent 聊天卡片 + 复用面板”为首个验收目标，默认文件点击接管作为独立后续项。

## Sources

[2] https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk
[6] https://molstar.org/docs/plugin/instance
[12] https://registry.npmjs.org/molstar/5.13.1
[13] https://registry.npmjs.org/molstar/-/molstar-5.13.1.tgz
