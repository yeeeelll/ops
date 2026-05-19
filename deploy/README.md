# 部署到 Linux 服务器 (Ubuntu / Debian + 宝塔)

本指南把项目从本地推到远程仓库, 服务器拉下来用 systemd 跑 Telegram bot。

## 一次性准备

### 1. 本地推到远程仓库

在本地 `D:\project\agent`:

```bash
git remote add origin <你的仓库 URL>
git branch -M main
git push -u origin main
```

仓库可用 GitHub、Gitee、Coding、自建 GitLab。无所谓, 服务器能 `git pull` 即可。

`.env` 在 `.gitignore` 里不会被推, 安全。

### 2. 服务器拉代码

SSH 上服务器, 选个目录 (建议 `/opt/ai-agent` 或 `/www/wwwroot/ai-agent`):

```bash
sudo mkdir -p /opt/ai-agent
sudo chown $USER:$USER /opt/ai-agent
git clone <你的仓库 URL> /opt/ai-agent
cd /opt/ai-agent
```

### 3. 配置 .env

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

必填:
- `OPENROUTER_API_KEY`
- `TELEGRAM_BOT_TOKEN` (BotFather 拿)
- `TELEGRAM_ALLOWED_USER_IDS` (你的 Telegram 数字 ID, 多个逗号分)
- `ALLOWED_PATHS` (例如 `/opt,/var/log,/www,/etc/nginx`)
- `READONLY_PATHS` (例如 `/etc/nginx,/var/log`)
- `NODE_ENV=production`

### 4. 安装依赖

服务器上 (确认有 node 20+):

```bash
node -v   # 需 >= v20
npm -v
npm install
```

如果 `node` 没在 PATH, 宝塔 PM2 插件的 node 在 `/www/server/nodejs/<version>/bin/node`。
可以建软链:

```bash
sudo ln -sf /www/server/nodejs/v20.19.6/bin/node /usr/local/bin/node
sudo ln -sf /www/server/nodejs/v20.19.6/bin/npm  /usr/local/bin/npm
sudo ln -sf /www/server/nodejs/v20.19.6/bin/npx  /usr/local/bin/npx
```

### 5. 启动前先 CLI 验证

```bash
npm run cli
```

`/model`、`/help`、试问 "磁盘使用率多少" 等。Linux 工具集应正常工作。

### 6. 安装 systemd 服务

```bash
sudo bash deploy/install.sh
```

脚本会:
1. 自动检测 APP_DIR / APP_USER / node 路径
2. 渲染 `deploy/ai-agent-bot.service` 模板
3. 安装到 `/etc/systemd/system/ai-agent-bot.service`
4. `systemctl daemon-reload && enable && restart`
5. 打印状态

如果 node 路径自动检测失败:

```bash
sudo NODE_BIN=/www/server/nodejs/v20.19.6/bin/node bash deploy/install.sh
```

## 日常运维

### 看日志

```bash
journalctl -u ai-agent-bot.service -f       # tail 实时
journalctl -u ai-agent-bot.service --since "1 hour ago"
tail -f logs/agent.log                       # 应用层日志 (info+)
```

### 更新代码

本地 `git push` 之后, 服务器上:

```bash
bash deploy/update.sh
```

脚本: `git pull` + (若 lock 变化) `npm ci` + `systemctl restart`。

### 启停

```bash
sudo systemctl status   ai-agent-bot.service
sudo systemctl restart  ai-agent-bot.service
sudo systemctl stop     ai-agent-bot.service
sudo systemctl start    ai-agent-bot.service
sudo systemctl disable  ai-agent-bot.service   # 取消开机自启
```

### 卸载

```bash
sudo systemctl disable --now ai-agent-bot.service
sudo rm /etc/systemd/system/ai-agent-bot.service
sudo systemctl daemon-reload
```

## 常见问题

### Q: bot 启动失败, journalctl 显示 "TELEGRAM_BOT_TOKEN 未配置"
A: `.env` 没生效。检查 `EnvironmentFile=` 行指向的路径, 以及 `.env` 文件权限是否对 APP_USER 可读。

### Q: Telegram bot 连接超时
A: 国内服务器需要走代理。.env 加:
```
HTTPS_PROXY=http://127.0.0.1:7890
HTTP_PROXY=http://127.0.0.1:7890
```
代码当前未显式读取该变量传给 telegraf, 后续要的话改 `bot.ts` 的 `bot.launch` 传 agent。

### Q: shell_ro 工具拒绝命令
A: `src/tools/shell.ts` 里 `READ_ONLY_BINARIES` 白名单。要加新命令, 编辑该 Set 并 redeploy。

### Q: 写工具 (fs.write / shell 写命令) 在哪
A: 暂未实现。P3 阶段加, 需配合 P4 权限层 + Telegram inline button 二次确认。
