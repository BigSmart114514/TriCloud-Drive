# TriCloud Drive

基于 Nuxt 4 ， Cloudflare D1/Sqlite3，腾讯云存储桶+CDN 的云存储应用，具备完整的用户认证功能。

> # ⚠警告，本项目刚刚从Nuxt3 迁移到 Nuxt4 有不可预知的风险

## 功能特性

- ✅ 用户注册和登录
- ✅ 基于 JWT 的认证系统
- ✅ 密码加密存储
- ✅ 响应式设计
- ✅ Cloudflare D1/ Sqlite3 数据库双兼容
- ✅ 腾讯云存储桶+CDN 云存储
- ✅ 用户下载和存储配额
- 🚧 管理（还需完善）
- ✅ 文件上传下载

## 技术栈

- **前端**: Nuxt 4, Vue 3, TailwindCSS
- **后端**: Nitro, Cloudflare Workers
- **数据库**: Cloudflare D1 (SQLite)/Sqlite3
- **认证**: JWT, bcrypt
- **云存储**: 腾讯云存储桶+CDN

## 本地开发

### 1. 安装依赖

```bash
npm install
```

### 2. 初始化数据库

- Sqlite3 数据库初始化

```bash
sqlite3 data.sqlite < ./server/database/schema.sql
```
**或**

- Cloudflare D1 数据库初始化

```bash
npx wrangler d1 execute tricloud-drive --local --file=server/database/schema.sql
```

### 3. 配置环境变量

```bash
cp env.example .env
```

> ⚠ 在一些服务器上，.env的文件如果是CRLF的格式会出现问题，如果有问题，请改为LF格式。

**或对于Windows用户**

```batch
copy env.example .env
```

并把.env 文件中的配置改成你自己的配置。

### 4. 启动开发服务器

```bash
npm run dev
```

应用将在 http://localhost:3000 启动。

## 部署

### 1、从github workflows下载编译过的文件。

https://github.com/BigSmart114514/TriCloud-Drive/actions

目前支持ubuntu24和windows。点击想要的版本后在主页的artifacts可以看到编译好的文件（没有就是过期了）。

### 2、安装nodejs

> 建议安装node v22.22.1 , 我们的编译统一使用这个版本

```
node -v
```

### 3. 初始化数据库

- Sqlite3 数据库初始化

```bash
sqlite3 data.sqlite < ./server/database/schema.sql
```

### 4. 配置环境变量

```bash
cp env.example .env
```

> ⚠ 在一些服务器上，.env的文件如果是CRLF的格式会出现问题，如果有问题，请改为LF格式。

**或对于Windows用户**

```batch
copy env.example .env
```

### 5、启动服务器

> 解压缩以后会有一个.output的文件夹

```
cd .output
./start.sh
```

**或者 使用PM2**

```
pm2 start ./start.sh --name "Tricloud-drive"
```

## 用户认证功能

### 注册新用户

1. 访问 `/register` 页面
2. 输入邮箱和密码（密码至少8位，包含字母和数字）
3. 确认密码
4. 点击注册按钮

> 如果你要关闭注册，请在.env 文件中设置 `ALLOW_REGISTER` 为 `false`

### 用户登录

1. 访问 `/login` 页面
2. 输入注册时的邮箱和密码
3. 点击登录按钮

### 认证状态

- 登录成功后，用户信息会保存在状态中
- 使用 HttpOnly Cookie 存储 JWT 令牌
- 自动检查认证状态
- 提供退出登录功能

### 退出登录

1. 点击导航栏`退出登录`按钮。

### 用户管理

1. 访问 `/manage` 页面
2. 可以搜索，添加，删除用户，也可以管理用户权限（待完善）

> 用户注册时 `IsAdmin` 和 `IsSuperAdmin` 默认为 `false` 。管理员请手动修改数据库。之后就可以在管理页面修改其他用户权限。

> ## ⚠警告：Admin 和 SuperAdmin权限划分还需要调整，非必要 **不要** 给Admin，只给普通用户权限就行了。


## 部署到 Cloudflare **(待完善)**

### 1. 创建 D1 数据库

```bash
npx wrangler d1 create tricloud-drive
```

### 2. 更新 wrangler.toml

将返回的数据库 ID 填入 `wrangler.toml` 的 `database_id` 字段。

### 3. 初始化远程数据库

```bash
npx wrangler d1 execute tricloud-drive --remote --file=server/database/schema.sql
```

### 4. 部署应用

```bash
npm run build
npx wrangler pages deploy dist
```

## 环境变量

- `SESSION_SECRET`: JWT 签名密钥（生产环境必须设置）

## 安全特性

- 密码使用 bcrypt 加密存储
- JWT 令牌存储在 HttpOnly Cookie 中
- 输入验证和错误处理
- 防止 SQL 注入（使用预处理语句）

