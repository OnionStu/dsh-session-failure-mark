# dsh-session-failure-mark

DSH Web GUI 插件：在左侧会话列表里标出「最近一轮没有正常结束」的会话，便于重开 DSH 后先处理失败的会话。

## 判定口径

插件读取每个会话的持久化事件日志，取最近一轮的结局：

| 结局 | 是否标记 | 说明 |
| --- | --- | --- |
| `error` | 是 | 模型请求失败，含连接错误、认证失败、额度用尽等，鼠标悬停可见原文与错误码 |
| `interrupted` | 是 | 日志里最近一个 `turn/start` 没有对应的 `turn/end`，即进程在本轮结束前退出 |
| `max-tokens` | 是 | 本轮达到输出 token 上限被截断 |
| `aborted` | 否 | 用户主动停止 |
| `blocked` | 否 | 被拦截结束 |
| `completed` | 否 | 正常完成 |

## 界面表现

- 会话行标题前的状态位显示红色圆点；
- 鼠标悬停该行，卡片内显示失败标题与错误原文；
- 会话行标题文字变红；
- 侧栏底部出现「N 个会话运行失败」入口。侧栏每个工作区分组只默认显示最近若干条，失败会话常被折叠，该入口先展开所有折叠分组，再把失败行滚入视野并短暂描边；存在多个失败时，重复点击依次跳到下一个。

运行中的会话不标记：它还没有结局，列表本身已经显示活动状态。已归档的会话同样不标记、不计入底部入口：侧栏默认不渲染归档行，计数它们会指向点不开的行。

## 数据与开销

宿主半边通过 `sessionPersistence` 读取日志：

- 每次查询先调用 `stat`，只读元数据；日志体积未变时直接命中缓存，不再读取；
- 只有变化的会话才打开日志，折叠到最近一个 `turn/end`；
- 结果按持久化 revision 缓存在 `~/.dsh/session-failure-mark/cache.json`，重开进程后仍然有效；
- 压缩体积超过 12 MB 的日志不读取：持久化接口会先把整份日志读入内存，大日志会造成宿主内存峰值，这类会话保持未标记。

浏览器半边只询问当前列表里最近的 48 个会话，每批 4 个，按 12 秒轮询，并在会话列表变化时触发一次。因此超过该范围的更早会话不参与标记与计数。

## 安装

将本仓库克隆到任意目录，下文以插件目录指代该克隆路径。

已登记到 web profile：

- `~/.dsh/profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles`；
- `~/.dsh/profiles/web/node_modules/dsh-session-failure-mark` 软链到插件目录。

改动生效需要重启 DSH 宿主，由用户自行执行 `~/.dsh/profiles/web/restart-dsh-web.sh`。

## 卸载

1. 删除软链 `~/.dsh/profiles/web/node_modules/dsh-session-failure-mark`；
2. 从 `~/.dsh/profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 中删除同名条目；
3. 重启宿主。

可选清理：删除 `~/.dsh/session-failure-mark/cache.json`。

## 已知限制

- 标题标红依赖宿主自己渲染的行结构：行元素带 `data-row-key="session:<id>"`，标题元素类名以 `_title` 结尾。DSH 升级若改动该结构，红点与悬停提示仍可用，标题颜色会失效。
- 会话列表的搜索结果行不在标记范围内。
