# 狐音思维导图

基于 [SimpleMindMap](https://github.com/wanglin2/mind-map) 的独立云端版本。保留原 MIT 许可证与作者归属。

## 功能
- 邀请注册、个人账号、个人文件夹与导图；其他账号不能读取或修改私有内容。
- 自动保存、版本冲突检测、最近 20 次保存历史、回收站。
- 只读分享链接（1 / 7 / 30 天），可以撤销；移入回收站时旧分享立即作废。
- 思绪原生格式、XMind 与 Markdown 导入；保留编辑器支持的导出。
- 图片沿用编辑器原生内嵌格式，随导图 JSON 一起保存在数据库中。
- 银白、淡紫、莓色的工具箱风格与深色模式。

## 本地构建
要求 Node.js 22。原编辑器仍使用 Vue 2，编译期间需要 OpenSSL legacy provider，已限定在构建子进程中。

```sh
npm ci --prefix simple-mind-map
npm ci --prefix web
npm ci --prefix cloud
node cloud/build-editor.mjs
```

构建输出是 cloud/editor/，不会覆盖原仓库 dist/。云端构建使用本 fork 的绘图核心。

## 测试
```sh
cd cloud
npm test
```
没有 TEST_DATABASE_URL 时数据库集成测试会跳过。完整测试使用单独临时 PostgreSQL。在仓库根目录运行以下命令：
```sh
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests
docker compose -f compose.test.yaml down
```
测试仅创建并删除随机命名的测试 schema；禁止将生产连接地址当作 TEST_DATABASE_URL。

## 部署
推荐目录：
```
/opt/konon-mindmap/
  .env             # 0600，POSTGRES_PASSWORD 随机生成
  .private/        # 0700，首次管理员邀请码
  data/postgres/   # 唯一正式数据库
  app/             # 本仓库发布产物
```

从 app/ 启动：
```sh
docker compose --env-file ../.env -f compose.cloud.yaml up -d --build
```
应用仅通过宿主回环 18465 端口访问，数据库没有宿主端口。
Nginx 保留 /mindmap/ 前缀反代至该端口，PUBLIC_URL 必须与公开站点一致。
修改公开域名时同时更新 compose 中 PUBLIC_URL；不要关闭来源检查。

首次管理员通过离线命令创建单次邀请码，不会开放“首个注册者自动成为管理员”：
```sh
docker compose --env-file ../.env -f compose.cloud.yaml run --rm --user root \
  -v /opt/konon-mindmap/.private:/run/private app node admin.mjs
```
邀请码写入私有文件而不输出到日志。已有管理员后此命令拒绝再次创建管理员。管理员在网页里生成普通用户邀请。密码至少 12 位。

## 备份与恢复
升级前保存源代码版本及工具箱增量清单，并用 pg_dump 备份数据库：
```sh
docker compose --env-file ../.env -f compose.cloud.yaml exec -T db pg_dump -U mindmap -d mindmap -Fc > ../.private/mindmap.dump
```
将备份复制到与服务器独立的受控存储。不要直接复制运行中的 PostgreSQL 数据目录作为唯一备份。
回滚应用只替换 app/ 发布版本、重建 app 容器，不删除 data/。工具箱静态页和 Nginx 按本次发布清单单独恢复。

需要恢复数据库时，先另存当前数据库的 pg_dump，再从 app/ 运行下列命令。此操作会将数据库替换为备份内容，备份之后的修改会丢失：
```sh
docker compose --env-file ../.env -f compose.cloud.yaml stop app
docker compose --env-file ../.env -f compose.cloud.yaml exec -T db pg_restore --clean --if-exists -U mindmap -d mindmap < ../.private/mindmap.dump
docker compose --env-file ../.env -f compose.cloud.yaml up -d app
```
仅在 pg_restore 成功后重新启动应用。先在隔离数据库验证备份可以恢复，再执行正式恢复。

## 边界
- 第一版是独立账号和只读分享；没有实时多人共同编辑。
- XMind 复杂样式/专有功能不保证完全往返兼容，重要原文件请保留。
- 单个请求最多 12 MB，单图最多 5000 个节点，深层级和非法结构会拒绝。
- Vue 2 及原编辑器旧依赖仍有后续迁移工作；本次做了针对共享场景的输入与渲染加固，不等同完整安全审计。
- 没有导入任何既有用户私有文件；可在工作台打开导图后使用“导入”迁移本地文件。
