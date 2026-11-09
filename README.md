# Easy CMDB

[English](README.en.md)

Easy CMDB 是一款简单易用的配置管理数据库，用于集中管理 IT 资产、基础设施配置和资产关系。项目面向中小规模、单机部署的运维场景：约 3000 台虚拟机，整体规模控制在 5000 台主机以内，少量运维人员即可维护。设计取舍是简单、够用、好维护：不引入额外中间件，也不追求大规模集群。当前支持物理机、虚拟机和交换机，提供资源详情、搜索筛选、CSV 导入导出、IPAM 网段与 IP 管理、操作审计以及数据中心机柜视图。

项目采用 Go、Vue 3 + TypeScript、Ant Design Vue 和 SQLite。一个 Go 二进制、一份 `web/dist` 前端产物和一个 SQLite 文件即可运行，不需要单独部署数据库服务。当前版本使用 SQLite；后续如有需要，可以再扩展 MySQL 或 PostgreSQL 后端。

## 适用场景

- 约 3000 台虚拟机，整体规模控制在 5000 台主机以内的单机环境；
- 少量运维人员日常维护，读多写少；
- 希望零数据库运维，备份就是复制一个数据库文件；
- 以手工维护和表格导入为主，需要资产关系、数据中心机柜和变更留痕。

不适合多节点同时写入、大规模多租户或高频并发编辑的场景。

## 本地运行

需要 Go 1.26+。首次运行还需要 Node.js 22 LTS（或满足 Vite 7 要求的版本）构建前端。

```bash
npm --prefix web ci
npm --prefix web run build
go build -trimpath -o bin/easy ./cmd/easy
```

SQLite 数据库默认是工作目录下的 `easy.db`，首次启动会自动创建数据库文件和表结构，不需要手动建库。启动 Web 服务：

```bash
./bin/easy serve
```

Windows PowerShell 对应：

```powershell
npm --prefix web ci
npm --prefix web run build
go build -trimpath -o bin/easy.exe ./cmd/easy
.\bin\easy.exe serve
```

访问 [http://127.0.0.1:8080](http://127.0.0.1:8080)。默认初始账号为 `admin`，密码为 `default`；按下面的配置修改密码。首次启动时台账为空，可在页面新增资产，或按下面的方式批量导入。

服务默认只监听 `127.0.0.1:8080`。对内网开放前，复制 `config.example.yaml` 为 `config.yaml`，在 `admin.password` 设置至少 12 字节的专用密码；通过 HTTPS 反向代理访问时，把 `cookie_secure` 设为 `true`。SQLite 数据库文件包含账号口令散列和资产数据，请限制数据库文件、备份文件和资产导出文件的访问权限。管理员、运维、只读账号在首次启动时按配置创建，已有账号使用数据库中保存的密码。

## 配置

所有配置都有默认值，不创建配置文件也能运行。需要修改时复制模板：

```bash
cp config.example.yaml config.yaml
```

`config.yaml` 已被 Git 忽略，可以放本机密码，不要提交。可用字段：

```yaml
listen: 127.0.0.1:8080
database: easy.db
web_dir: web/dist
cookie_secure: false

admin:
  username: admin
  password: ""

operator:
  username: ""
  password: ""

viewer:
  username: ""
  password: ""
```

- `admin.password` 留空时使用默认密码 `default`；对内网开放前改为至少 12 字节。
- `operator` / `viewer` 两项都留空表示不创建该账号。
- 账号只在首次启动时创建，之后修改 `config.yaml` 不会改变已有账号的密码。

## 资产维护

零散资产可以直接在页面点击「新增资产」手工维护。资产较多时使用 CSV 批量导入：在 Excel 中编辑后另存为「CSV UTF-8」（逗号分隔），在资源列表点击「下载模板」，填写后点击「导入 CSV」。

模板列如下：

```text
资源名称,类型,平台,状态,生命周期,地址 / IP,CPU,内存 MiB,负责人,环境,备注,扩展属性
```

- 类型：物理机、虚拟机、交换机；也接受 `host`、`vm`、`switch`。
- 平台：Proxmox VE、KVM 或留空；也接受 `pve`、`kvm`。
- 状态：未知、在线、离线、运行中、已停止、已暂停；也接受对应英文代码。
- 生命周期：在册、已退役；留空默认在册。
- 扩展属性：JSON 对象，例如 `{"位置":"A01"}`；留空为 `{}`。
- CPU 和内存 MiB 填非负整数。

导入规则：

- 单次最多 5000 行、16 MiB；
- 整批校验和写入，任何一行失败都不会写入部分数据；
- 导入只新增，不修改已有资产；
- 资源名称不能与已有资产或本次文件中的其他行重复，避免重复导入；
- 导入成功后会在变更记录中留下记录，操作人为当前登录账号。

导出的 CSV 使用同一套列名，可以作为批量导入的填写参考。

## IP 地址管理

在「IPAM」中新增网段，填写 CIDR、网关和 VLAN。系统会自动统计资产「地址 / IP」中落在该网段的地址，也可以在网段下手工分配、关联资产和释放 IP。

- 支持 IPv4 `/8` 到 `/30`，网段之间不允许重叠；
- 资产地址支持逗号、分号或空格分隔的多个 IP；
- 已用 IP 包括网关、资产地址和手工分配；
- 空闲 IP 显示前 50 个，总空闲数按网段容量计算；
- 网关地址不能再次分配；资产地址已使用的 IP 不需要重复分配；
- 网段和 IP 分配变更会记录在「变更记录」。

## 数据中心

在「数据中心」新增数据中心并设置网格大小，再添加机柜编号、高度、网格坐标和朝向。平面视图可以把机柜拖到空格，编辑表单也可直接设置位置。3D 总览支持旋转、缩放、选择机柜和打开设备详情。

在机柜正视图选择「上架设备」，关联已有资产，或新建物理机或交换机后同时上架。填写起始 U 位和占用 U 数，系统会检查重叠及越界。资产详情可反向定位到数据中心和机柜。虚拟机沿宿主机关系定位，下架设备会保留资产记录。

机柜布局以网格单元表示。U 位、资产位置和布局由同一份数据驱动，数据中心、机柜和设备位置的修改记录在「变更记录」。

## 数据备份

停止 Web 服务后再复制 SQLite 文件。数据库使用 WAL 模式，正常退出时最后一条连接会把 WAL 合并回主文件。若目录中仍有 `easy.db-wal` 或 `easy.db-shm`，说明进程没有正常关闭，请重新启动并正常停止一次再备份。

```bash
cp easy.db easy-cmdb.db
```

恢复前先在副本上验证。恢复时停止服务，替换数据库文件，并删除可能残留的 `easy.db-wal`、`easy.db-shm`，再重新启动。

## 开发

首次构建前端后，可用 `npm --prefix web run dev` 启动前端开发服务，它会把 `/api` 请求代理到本机 8080 的 Go 服务。Go 服务可用 `go run ./cmd/easy` 启动。`go test ./...` 检查 Go 包，`npm --prefix web run check` 执行 Vue 类型检查。

表结构在 `internal/cmdb/schema.sql`，首次启动时自动执行。项目仍在开发阶段，修改表结构后删除本地 `easy.db` 并重启即可重建，不需要迁移文件。

## 许可证

使用 [Apache License 2.0](LICENSE)。
