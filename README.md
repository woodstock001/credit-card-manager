# 信用卡管家（自用版）

一个完全属于自己的信用卡 + 固定月供管理小应用。纯前端，无构建步骤，数据存在自己的 Supabase 云端数据库。

## 功能

- **多卡管理**：银行、别名、尾号、额度、账单日、还款日、自动还款
- **账单记录**：按卡按账期记录，自动算已还 / 待还 / 状态
- **还款记录**：记一笔还款自动回写账单，删除自动回滚
- **固定月供**：房贷 / 房租，每月固定日期固定金额，支持 31 号在小月自动落到月末
- **提醒**：首页顶部大字提示最近到期项，逾期红、5 天内橙；信用卡账单和月供合并排序
- **分析**：额度使用率、本月/本年收支、近 12 个月账单趋势、固定支出构成
- **备份**：一键导出 JSON，可导入恢复
- **PWA**：可添加到手机桌面，像 App 一样用

## 技术说明

- 无框架、无 npm、无构建：`index.html` + `style.css` + `app.js`
- 直接调用 Supabase REST（PostgREST）和 Auth 接口，不依赖任何 CDN
- 金额统一按「分」存 bigint，避免浮点误差
- 每个账号的数据用 RLS 隔离，别人拿到 anon key 也读不到你的数据

## 部署步骤

1. Supabase 新建项目
2. 打开 SQL Editor，粘贴执行 `supabase/schema.sql`
3. Project Settings → API，复制 `Project URL` 和 `anon public` key
4. 填到 `config.js`：
   ```js
   window.APP_CONFIG = {
     SUPABASE_URL: "https://xxxx.supabase.co",
     SUPABASE_ANON_KEY: "eyJhbGciOi..."
   };
   ```
5. 推到 GitHub，仓库 Settings → Pages → Source 选 `main` 分支 `/ (root)`
6. 访问 `https://<用户名>.github.io/credit-card-manager/`

## 首次使用

1. 打开网页，点「第一次用，注册账号」，填邮箱 + 密码
2. 若 Supabase 开启了邮箱确认，去邮箱点确认链接后再登录
3. 设置页添加信用卡 → 账单页记账单 → 首页看提醒

## 目录

```
index.html            页面结构
style.css             样式（深色/浅色自适应）
app.js                全部逻辑
config.js             数据库配置
manifest.webmanifest  PWA 配置
supabase/schema.sql   建表脚本（含 RLS）
```
