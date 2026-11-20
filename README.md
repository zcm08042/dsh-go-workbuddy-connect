# dsh-go-workbuddy-connect

一个面向 **dsh-go 手机本机引擎**的原生插件：用你自己的 WorkBuddy / CodeBuddy 账号登录态调用模型，**积分扣在你自己的 WorkBuddy 账号上**，并在 App 里显示只读积分概览。

实现参考 [`dingminhua/dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy) 的协议：浏览器扫码登录 → `/v2/plugin/auth/*` 换 token → `/v2/chat/completions` 调用模型 → `/v2/billing/meter/get-user-resource` 读积分。手机本机环境没有桌面 App，因此本插件只走**浏览器登录**路线，不依赖桌面客户端、不搬运加密凭据。

## 功能

- `workbuddy_login` / `workbuddy_login_finish`：浏览器登录并保存凭据（凭据放 `$DSH_HOME/workbuddy-go-connect/credential.json`，权限 0600）。
- `workbuddy_credits`：只读积分概览（总额、剩余、积分包）。
- `workbuddy_models`：列出当前账号可用模型 id。
- `workbuddy_chat`：调用 WorkBuddy 模型，结果带工具卡，显示本次积分消耗（上游返回时）。
- 原生界面：输入框胶囊「WorkBuddy」、状态条积分读数、面板（登录 / 打开登录页 / 检查登录 / 刷新积分 / 退出登录）。

## 安装（手机 dsh-go）

1. 把整个 `dsh-go-workbuddy-connect/` 目录放进手机本机 Linux 环境，例如 `/root/.dsh/dsh-go/plugins/`（可通过「设置 → 访问手机文件」把文件夹放到 `/sdcard/Download/`，再在 App 终端里 `cp -r`）。
2. 在 App 的「终端」里执行：

   ```sh
   dsh plugin --profile web add /绝对路径/dsh-go-workbuddy-connect
   ```

3. 不用重启：桥接会按文件修改时间重读清单。如果界面没出现，在「引擎」页重启本机引擎。
4. 点输入框上方的「WorkBuddy」胶囊打开面板 → 点「登录」→ 点「打开登录页」→ 在浏览器里完成登录 → 回面板点「检查登录」。
5. 让模型调用 `workbuddy_models` 看模型 id，再调用 `workbuddy_chat` 并传入 `model` 和 `prompt`。

卸载：

```sh
dsh plugin --profile web remove dsh-go-workbuddy-connect
```

## 登录区域

- `cn`：国内版 WorkBuddy / CodeBuddy，登录域名 `www.codebuddy.cn`，模型网关 `copilot.tencent.com`。
- `global`：国际版，登录域名 `www.workbuddy.ai` 或 `www.codebuddy.ai`。面板里的「登录」按钮默认 `cn`；要用国际版，让模型调用 `workbuddy_login` 并传 `region: "global"`。

## 风险与限制（务必先看）

- **非官方接口**：本项目复刻社区插件的协议，不是 WorkBuddy 官方 SDK。上游可能调整接口、请求头或风控策略，插件可能失效。请自行评估账号风险。
- **真实扣费**：每次 `workbuddy_chat` 都会按你账号的积分倍率真实扣费，插件不修改账号状态、不绕过计费。
- **只读积分**：只读取积分概览，没有“查余额 API 的官方承诺”；上游字段变化会导致读数不准或失败。
- **不注册模型供应商**：本插件提供的是工具（`workbuddy_chat`），不会把 dsh-go 的默认模型整体替换成 WorkBuddy。如果你想要“全量模型接管”，那是更大的改造，需要单独做。
- **凭据安全**：token 只存在本机环境 `credential.json`，不会发给插件作者。不要把这个文件发给别人或提交到仓库。

## 自查

```sh
node --check lib/index.js
node --check lib/upstream.js
node --check lib/store.js
node --check lib/views.js
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json ok')"
```

## 许可

MIT
