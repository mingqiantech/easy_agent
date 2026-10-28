# Mac 远程连接 Windows 配置指南（Windows App / RDP）

> 整理日期：2026-10-27
> 适用：Mac 通过 RDP 连接局域网/远程 Windows 机器

---

## 一、Mac 客户端安装

1. 打开 **Mac App Store**，搜索 **Windows App**（开发者 Microsoft）
   - ⚠️ 原 "Microsoft Remote Desktop" 已更名为 **Windows App**，老版本仍可用但不再更新
2. 安装最新版

## 二、Windows 端准备（否则连不上）

1. 设置 → 系统 → 远程桌面 → **打开**
2. 确认系统版本为 **专业版 / 企业版**
   - 家庭版不支持被远程（需 RDP Wrapper 或换系统）
3. 防火墙默认放行 **3389** 端口；跨网段连接需在路由器做端口映射
4. 建议给 Windows 设置 **静态 IP 或 DHCP 地址保留**，避免 IP 变动连不上
5. 账户必须有**密码**（PIN 码不能用于 RDP）

## 三、添加连接信息

打开 Windows App → 点击 **+** → **Add PC**

| 字段 | 填写内容 |
|---|---|
| PC name | Windows 的 IP（如 `192.168.1.105`）或主机名 |
| User account | 添加用户名和密码，格式见下 |
| Gateway | 仅 RD 网关场景需要：填网关域名，确保证书受信任 |

### 用户名格式

- **本地账户**：`.\用户名`（一个点 + 一个反斜杠，注意不是 `.\\`）
- **微软账户登录的 Windows**：
  - 密码 = 微软账户密码（不是 PIN）
  - 用户名可试 `.\邮箱`；`MicrosoftAccount\邮箱` 格式往往无效
  - 最稳妥方案：在 Windows 上单独建一个本地账户用于 RDP

## 四、连接后常用设置

- **Display 标签**
  - 勾选 "Start session in full screen" 或 "Fit to window"
  - Retina 屏建议分辨率 ≥ 1920×1080，否则字太小
- **Devices 标签**
  - 剪贴板重定向（默认开启）—— Mac ↔ Windows 传文本的关键
  - 可按需重定向文件夹、麦克风
- **User account** 添加一次后，多台 PC 可复用

## 五、排错速查

| 现象 | 原因 / 解决 |
|---|---|
| 连不上、超时 | RDP 未开启 / 家庭版 / 防火墙拦截 / IP 变了 |
| 凭据错误 | 用了 PIN；微软账户密码问题；改用 `.\用户名` 格式 |
| 证书警告 | 自签名证书属正常，勾选"始终信任"；仅 RD 网关需正式受信任证书 |
| 画面模糊 / 字小 | Display 里调高分辨率 + 开启 HiDPI 匹配 |
