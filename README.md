# FileShare

> v1.1.8：新增管理员存储空间配置，可设置单个文件上传上限和整个 `/app/files` 空间上限。

轻量、无数据库、无用户登录的 Node.js 文件分享系统。

## 功能

- `/files` 文件/文件夹管理
- 上传文件
- 上传整个文件夹并保留目录结构
- 拖拽上传
- 新建文件夹、重命名、删除
- 文件或文件夹生成分享链接
- 分享密码
- 有效期
- 最大下载次数
- 下载次数统计
- 文件夹下载时自动流式 ZIP 打包
- 分享管理：搜索、修改、复制、取消、批量取消
- 管理员密码保护
- 管理员存储空间配置：单个文件最大大小、整个空间大小
- JSON 持久化，无数据库
- Docker 单容器
- GitHub Actions 手动构建并推送 GHCR
- `linux/amd64`、`linux/arm64`、`linux/arm/v7` 多架构

## v1.1.8 更新

- 管理设置新增“存储空间”配置页。
- 支持设置单个文件最大上传大小（MB）。
- 支持设置整个 FileShare 空间上限（GB）。
- 空间上限为 `0` 时表示不限。
- 超过单文件限制或空间总量限制时，上传会被拒绝。
- 设置持久化到 `/app/data/config.json`。

## v1.1.8 存储空间配置

进入右上角 **管理设置 → 存储空间**，可以配置：

- **单个文件最大上传大小**：单位 MB，范围 1～1048576 MB。
- **整个存储空间大小**：单位 GB，设置为 `0` 表示不限。
- 当单个文件超过限制时，上传会直接拒绝。
- 当 `/app/files` 当前已使用空间 + 本次上传文件总大小超过空间上限时，整批上传会拒绝。
- 设置会保存到 `/app/data/config.json`，重启容器后仍然有效。
- Docker 宿主机实际磁盘容量仍然是最终物理上限。

侧边栏的“存储空间”会显示当前使用量；设置了空间上限后，还会显示使用百分比。

## v1.1.7 管理员密码初始化

v1.1.7 修复了 Docker / OpenWrt 场景下管理员密码初始化不可靠的问题。首次启动会读取 `ADMIN_PASSWORD`，并自动尝试生成 `/app/data/config.json`。即使 `/app/data` 暂时没有写权限，程序也会使用环境变量密码继续运行，并在日志中明确提示检查目录挂载和权限。

查看状态：

```bash
curl http://服务器IP:30286/api/health
```

正常首次初始化时应看到：

```json
{
  "configExists": true,
  "configSource": "file",
  "dataWritable": true
}
```

如果 `configExists` 为 `false`，请检查 Docker 是否正确映射：

```text
宿主机数据目录 → /app/data
```

并确保该目录可写。

## 快速启动

修改 `docker-compose.yml` 中的 `ADMIN_PASSWORD`，然后：

```bash
docker compose up -d
```

访问：

```text
http://服务器IP:30286
```

## GHCR

GitHub Actions 已设置为**手动运行**，不会因为 push、Tag 或 Release 自动构建。进入 GitHub → Actions → Build and Push Docker Image → Run workflow，填写镜像 Tag（例如 `latest`）后运行。

```bash
docker pull ghcr.io/YOUR_GITHUB_USERNAME/fileshare:latest
```

然后把 `docker-compose.yml` 中的镜像名改成自己的 GitHub 仓库。

## 群晖 Container Manager 部署

### 图形界面

在群晖 **Container Manager → 映像** 中下载：

```text
ghcr.io/YOUR_GITHUB_USERNAME/fileshare:latest
```

创建容器：

**端口：**

```text
群晖端口    容器端口
30286       30286
```

协议：`TCP`

**文件夹映射：**

```text
群晖目录                              容器目录
/volume1/docker/fileshare/files  →  /app/files
/volume1/docker/fileshare/data   →  /app/data
```

**环境变量：**

```text
PORT=30286
TZ=Asia/Shanghai
ADMIN_PASSWORD=你的管理员初始密码
```

启动后：

```text
http://群晖IP:30286
```

### Container Manager 项目

也可以直接使用：

```yaml
services:
  fileshare:
    image: ghcr.io/YOUR_GITHUB_USERNAME/fileshare:latest
    container_name: fileshare
    restart: unless-stopped
    ports:
      - "30286:30286"
    environment:
      TZ: Asia/Shanghai
      PORT: 30286
      ADMIN_PASSWORD: 请修改成强密码
    volumes:
      - ./files:/app/files
      - ./data:/app/data
```

## Docker Run 部署

创建目录：

```bash
mkdir -p /volume1/docker/fileshare/files
mkdir -p /volume1/docker/fileshare/data
```

拉取镜像：

```bash
docker pull ghcr.io/YOUR_GITHUB_USERNAME/fileshare:latest
```

启动：

```bash
docker run -d \
  --name fileshare \
  --restart unless-stopped \
  -p 30286:30286 \
  -e PORT=30286 \
  -e TZ=Asia/Shanghai \
  -e ADMIN_PASSWORD='请修改成强密码' \
  -v /volume1/docker/fileshare/files:/app/files \
  -v /volume1/docker/fileshare/data:/app/data \
  ghcr.io/YOUR_GITHUB_USERNAME/fileshare:latest
```

检查：

```bash
docker ps
docker logs -f fileshare
```

正常日志：

```text
FileShare listening on :30286
```

## 更新镜像

```bash
docker pull ghcr.io/YOUR_GITHUB_USERNAME/fileshare:latest
docker stop fileshare
docker rm fileshare
```

然后重新执行 `docker run`。

由于 `/app/files` 和 `/app/data` 已映射到宿主机，重建容器不会删除文件和分享数据。

## 目录说明

```text
/app/files        实际文件
/app/data         shares.json、config.json
/app/uploads      上传临时目录
```

`/app/uploads` 不需要持久化。

## 管理员密码

首次启动必须设置 `ADMIN_PASSWORD`。

该变量只用于第一次创建：

```text
/app/data/config.json
```

之后管理员密码通过 Web 管理设置修改。

如果忘记密码：

1. 停止容器。
2. 备份 `data/config.json`。
3. 删除 `data/config.json`。
4. 设置新的 `ADMIN_PASSWORD`。
5. 重新创建容器。

## 分享链接

格式：

```text
http://服务器IP:30286/s/<token>
```

分享状态：

- 正常
- 已过期
- 次数用尽
- 已取消

密码分享采用一次性短期签名下载凭证，不会把分享密码放进下载 URL。

## 安全建议

生产环境建议：

- 使用强管理员密码
- 通过 HTTPS 反向代理访问
- 不直接将管理端口暴露到公网
- 定期备份 `/app/files` 和 `/app/data`

## 上传说明

上传临时文件会放在 `/app/files/.fileshare-tmp`，与实际文件位于同一个 Docker volume 中，然后在同一文件系统内完成移动，避免群晖等 Docker 环境出现 `EXDEV: cross-device link not permitted`。该临时目录不会显示在文件列表中。

## 存储空间设置说明

FileShare 的空间限制是应用层限制，不会修改 Docker、OpenWrt 或群晖的磁盘配额。

例如设置：

```text
单个文件最大上传大小：2048 MB
整个存储空间大小：100 GB
```

则：

```text
2 GB 以上的单个文件       → 禁止上传
当前已使用 95 GB
本次上传 6 GB             → 禁止上传
当前已使用 95 GB
本次上传 4 GB             → 允许上传
```

如果整个空间设置为：

```text
0 GB
```

表示不限制 FileShare 空间，但仍受宿主机实际磁盘容量限制。


## 临时网盘 / 来宾账号

FileShare 支持创建来宾账号，用于把 Docker 容器临时当作一个轻量网盘使用。

管理员进入 **管理设置 → 来宾账号** 可以：

- 新建来宾账号
- 停用/启用来宾账号
- 修改来宾密码
- 删除来宾账号

来宾登录后仅允许：

- 浏览 `/files` 文件和文件夹
- 双击进入文件夹
- 下载文件
- 下载文件夹（自动打包 ZIP）

来宾不能：

- 上传文件
- 新建文件夹
- 重命名
- 删除
- 移动文件
- 创建或修改分享
- 修改管理员设置

来宾登录地址与 FileShare 管理页面相同，打开后选择 **来宾访问** 即可。来宾登录会生成临时会话，默认有效期 12 小时。

## 文件下载与移动

管理员在文件列表中可以直接使用 **下载**，文件夹下载时会自动生成 ZIP。

管理员还可以使用 **移动** 将文件或文件夹移动到其他目录；目标目录已有同名项目时会自动生成 `(1)`、`(2)` 等名称。

## License

MIT

## GHCR 与 GitHub Actions

GitHub Actions 改为**手动运行**，不会因为 `push`、Tag 或 Release 自动构建。

工作流位于：

```text
.github/workflows/build.yml
```

在 GitHub 仓库进入：

```text
Actions → Build and Push Docker Image → Run workflow
```

运行时可以填写镜像标签，例如：

```text
latest
```

构建完成后镜像为：

```text
ghcr.io/YOUR_GITHUB_USERNAME/fileshare:latest
```

也可以手动填写版本号，例如：

```text
1.1.0
```

得到：

```text
ghcr.io/YOUR_GITHUB_USERNAME/fileshare:1.1.0
```

当前工作流构建以下多架构：

```text
linux/amd64
linux/arm64
linux/arm/v7
```

因此群晖、Intel/AMD x86、ARM64 等设备统一使用对应的镜像地址即可。

