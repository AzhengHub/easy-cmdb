# Radar CMDB

[English](README.en.md)

Radar CMDB 是一款通用的企业配置管理数据库，用于集中管理 IT 资产、基础设施配置和业务关系。当前支持物理机、机箱与计算节点、虚拟化集群和虚拟机，提供资源详情、搜索筛选、CSV 导出、操作审计，以及对 Proxmox VE 和独立 KVM 的只读采集。项目采用 Go、Vue 3 + TypeScript 和 PostgreSQL。

## 本地试用

需要 Docker 和 Compose v2.24 或更新版本。先复制配置。

```bash
cp .env.example .env
```

使用 `openssl rand -hex 24` 生成数据库密码，填入 `.env` 的 `POSTGRES_PASSWORD`，再启动服务。

```bash
docker compose up --build -d
```

访问 [http://127.0.0.1:8080](http://127.0.0.1:8080)，用初始账号 `admin` 和密码 `default` 登录。首次启动时台账为空，可在页面新增资产，或按下文接入采集。

Compose 默认只在本机监听。对内网开放前，在首次启动时通过 `RADAR_ADMIN_PASSWORD` 设置至少 12 字节的专用密码。若自定义 `RADAR_ADMIN_USER`，同时设置密码。通过 HTTPS 反向代理访问时，可设置 `RADAR_COOKIE_SECURE=true`。数据库密码用于连接 URL，建议使用十六进制随机值。管理员、运维、只读账号通过环境变量首次创建，已有账号使用数据库中保存的密码。

## 接入 PVE 和独立 KVM

1. 创建 `collector-data/ssh`，将 `collectors.example.json` 复制到 `collector-data/sources.json`，按实际环境修改。每个 PVE 集群配置一项，每台独立 libvirt 宿主机配置一项。给每个数据源分配唯一且长期不变的 `key`。
2. PVE 为采集账号和 API Token 授予所需资源范围内的查询权限。启用 Token 权限分离时，账号和 Token 都需要相应 ACL。在 `collector-data/credentials.env` 中设置 `tokenEnv` 指定的变量，例如 `RADAR_PVE_TOKEN='radar@pve!inventory=<token secret>'`。将集群 CA 复制到配置的 `caFile` 路径。节点地址需与证书名称匹配。基础清单采集通过集群资源接口，开启 `vmDetails` 会逐台读取虚拟机配置以获取网卡、磁盘引用和可用的实例标识。
3. KVM 在采集端使用 `virsh --readonly`，通过 SSH 密钥连接 libvirt。将专用私钥和已核验的 `known_hosts` 放到 `collector-data/ssh/`，必要时添加 SSH `config`。容器以 UID 10001 运行，确保该用户能读取这些文件，并把私钥权限设为仅所有者可读写。对于本地运行的采集进程，也可配置 `qemu:///system`。
4. 启动采集，在页面的「采集状态」查看结果。

```bash
docker compose --profile collect up -d
docker compose --profile collect logs collector
```

单次采集可执行 `docker compose --profile collect run --rm collector collect --once`。同一个数据源同一时间只执行一轮采集。

采集维护资源名称、CPU、内存、状态和虚拟化关系。负责人、业务、环境、管理地址及自定义属性由运维人员维护。连续两轮成功同步都未发现的资源标记为待核查，退役由人工确认。采集错误保留上次记录。PVE 同集群迁移沿用原资产 ID，变更时间表示采集发现时间。接入现有库存时，建议先运行采集，再为发现的节点补充机箱关系和业务资料。

当前版本采集范围是 PVE QEMU 虚拟机与 libvirt 域。虚拟机 IP、硬件序列号等可人工补录。iDRAC / Redfish、Guest Agent IP 自动采集、CSV 批量导入和跨 KVM 数据源迁移归并留待后续接入。

## 数据备份

每天在部署机运行逻辑备份，并将生成的文件同步到独立存储。

```bash
docker compose exec -T db pg_dump -U radar -d radar -Fc > radar-cmdb.dump
```

恢复前先使用单独的空数据库验证备份。下面的命令在已运行的 PostgreSQL 服务中创建一个恢复验证库，保留原库。

```bash
docker compose exec -T db createdb -U radar radar_restore
docker compose exec -T db pg_restore -U radar --exit-on-error -d radar_restore < radar-cmdb.dump
```

## 开发

Go 1.26+，Node.js 22 LTS 或满足 Vite 7 要求的 Node.js，PostgreSQL 17。前端开发服务将 `/api` 代理到本机 8080。使用独立的开发数据库。

```bash
npm --prefix web ci
npm --prefix web run build
export RADAR_DATABASE_URL='postgres://radar:<password>@127.0.0.1:5432/radar?sslmode=disable'
export RADAR_ADMIN_PASSWORD='<at-least-12-bytes>'
go run ./cmd/radar
```

`go test ./...` 检查 Go 包，`npm --prefix web run check` 执行 Vue 类型检查。Go 服务在 8080 端口运行后，可通过 `npm --prefix web run dev` 启动前端开发服务，它会把 `/api` 请求代理给 Go。采集进程和 API 使用同一个程序，通过 `radar collect` 和 `radar serve` 分别启动。

## 许可证

使用 [Apache License 2.0](LICENSE)。
