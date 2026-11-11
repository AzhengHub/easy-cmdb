# dc-db

[简体中文](README.md)

dc-db is a simple, easy-to-use configuration management database for IT assets, infrastructure configuration, and asset relationships. It targets small, single-node operations: around 3,000 virtual machines with a total footprint under 5,000 hosts, maintained by a small operations team. The design goal is simple, sufficient, and easy to maintain: no extra middleware and no large-cluster ambitions. It tracks physical hosts, virtual machines, and switches, with a home dashboard, asset search, relationship views, CSV import and export, IPAM subnet, VLAN, and address management, access controls, change history, and data center/rack views.

dc-db uses Go, React 19 with TypeScript, Ant Design 6, ECharts, and SQLite. One Go binary, the built `web/dist` assets, and one SQLite file are all it needs; there is no separate database service to deploy. The current release uses SQLite, and a MySQL or PostgreSQL backend can be added later if needed.

The interface supports light and dark themes. It follows the system preference on first visit, can be switched from the login page or header, and remembers the choice in the browser.

## Scope

- Around 3,000 virtual machines with a total footprint under 5,000 hosts on a single node.
- A small operations team with read-heavy usage.
- No database service to operate; a backup is a single database file.
- Manual maintenance and spreadsheet import as the primary workflow, with asset relationships, data center/rack views, and change history.

It is not designed for multi-node concurrent writes, large multi-tenant deployments, or high-frequency concurrent editing.

## Run locally

Use Go 1.26 or later. The first run also needs Node.js 22 LTS or another version supported by Vite 7 to build the frontend.

```bash
npm --prefix web ci
npm --prefix web run build
go build -trimpath -o bin/dc-db ./cmd/dc-db
```

The SQLite database defaults to `dc-db.db` in the working directory. The first start creates the database file and schema automatically; there is no manual setup step. Start the web service:

```bash
./bin/dc-db serve
```

On Windows PowerShell:

```powershell
npm --prefix web ci
npm --prefix web run build
go build -trimpath -o bin/dc-db.exe ./cmd/dc-db
.\bin\dc-db.exe serve
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080). The default initial sign-in is `admin` with password `default`; change it in the configuration below. Login requires a graphical captcha, valid for five minutes and usable only once. A new installation starts with an empty inventory. Add assets in the web interface or use CSV import as described below.

The service binds to `127.0.0.1:8080` by default. Before the first start of a network-accessible installation, copy `config.example.yaml` to `config.yaml` and set `admin.password` to a unique password of at least 12 bytes. Set `cookie_secure: true` when serving the application through an HTTPS reverse proxy. The SQLite database file contains password hashes and asset data, so restrict access to the database file, backups, and asset exports. Accounts are created from the configuration on first start; existing accounts use their stored passwords.

## Configuration

Every setting has a default, so the program runs without a configuration file. To customize it, copy the example:

```bash
cp config.example.yaml config.yaml
```

`config.yaml` is ignored by Git so it can hold local passwords. Available fields:

```yaml
listen: 127.0.0.1:8080
database: dc-db.db
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

- Leaving `admin.password` empty uses the default password `default`; change it to at least 12 bytes before exposing the service.
- Leaving both `operator` / `viewer` fields empty disables that account.
- Accounts are created only on first start; changing `config.yaml` later does not change an existing account's password.

## System management

The `系统管理` section contains:

- **Change history**: review changes to assets, relationships, and facilities, filtered by asset, actor, or action, and export the current result; tag changes list added and removed tags
- **Change password**: update the password for the signed-in account

The All assets view covers physical hosts, virtual machines, and switches. Clicking a tag's asset count opens that tag's assets in the combined view.

Changing the password requires the current password and a new password of at least 12 characters. After a successful change, every session for the account is revoked and the user must sign in again.

## Deploy to a Linux server

The server-side installer is `scripts/install.sh`. It installs a prebuilt `dc-db` binary and frontend `dist/`; it does not build them. A fresh clone cannot be installed directly on a server without Go/Node. A one-command release installer will be added when release packages are available.

Build the Linux artifacts first:

```bash
npm --prefix web ci
npm --prefix web run build
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o dc-db ./cmd/dc-db
```

Place these files together:

```text
install.sh
dc-db
dist/
```

Then run as root:

```bash
sudo APP_PORT=80 bash install.sh
```

The installer creates the `dc-db` system account, installs under `/opt/dc-db`, writes `config.yaml`, installs the embedded systemd unit, and starts the service. Port 80 is granted through `CAP_NET_BIND_SERVICE` while the service runs as a normal user. The first install prints the administrator password; repeat deployments preserve the existing configuration and database.

To force a listen-port change on an existing installation:

```bash
sudo APP_PORT=80 UPDATE_LISTEN=1 bash install.sh
```

## Asset management

Add individual assets with the `新增资产` button. For larger inventories, use CSV import: edit the file in Excel and save it as `CSV UTF-8` (comma-separated), click `下载模板` on the asset list to get the template, fill it in, then click `导入 CSV`. The file is validated and previewed first; row errors are listed for correction and can be downloaded as a CSV report, and data is written only after you confirm.

Template columns:

```text
资源名称,类型,平台,状态,生命周期,地址 / IP,CPU,内存 MiB,负责人,环境,备注,扩展属性,标签
```

- Type: `host`, `vm`, `switch`, or the Chinese labels 物理机, 虚拟机, 交换机.
- Platform: `pve`, `kvm`, `Proxmox VE`, `KVM`, or empty.
- Status: `unknown`, `online`, `offline`, `running`, `stopped`, `paused`, or the Chinese labels 未知, 在线, 离线, 运行中, 已停止, 已暂停.
- Lifecycle: `active`, `retired`, 在册, 已退役; empty defaults to active.
- Attributes: a JSON object such as `{"位置":"A01"}`; empty becomes `{}`.
- Tags: separate multiple tags with semicolons or commas, for example 生产; 核心; tags must already exist under Tags, otherwise the whole import is rejected.
- CPU and memory MiB must be non-negative integers.

Import rules:

- Up to 5,000 rows and 16 MiB per import;
- Validation and insert run in one batch; if any row fails, nothing is written;
- Import only creates new assets; it never overwrites an existing asset;
- Tags are matched by name and are never created automatically;
- Asset names must not duplicate an existing asset or another row in the same file;
- Successful imports appear in change history under the current account.

Exported CSV files use the same columns and can be used as a reference when preparing an import.

Asset details are organized into overview, relationships, custom attributes, and change history tabs, with a relationship graph in the relationships tab. Custom attributes use a key-value editor with text, number, boolean, and JSON value types. Assets can carry multiple colored tags: maintain tags under `System → Tags`, then select them from the asset detail `Tags` button. Tags appear in the asset list and can be used as a filter; with multiple tags you can choose all-of or any-of matching, and saved filter presets keep both the tag array and match mode. The global search also finds tags by name or description. Select multiple assets to add, remove, or replace tags in bulk. Star assets from the list or detail view to keep them in the dashboard `My favorites` shortcut. The dashboard also charts tag usage. The asset list supports status filters, saved filter presets, configurable columns, click-to-sort headers, and 10/20/50 page sizes. Select multiple assets to bulk-edit status, platform, lifecycle, owner, and environment. The global header search covers assets, IP addresses, data centers, racks, subnets, and VLANs, shows the last six searches when empty, and can jump to `All assets` with the current keyword.

## IP address management

`IPAM` is organized into `Subnets & IPs`, `IP addresses`, and `VLANs`.

The VLAN inventory records a VLAN ID (1–4094), name, status, optional data center, and description. A subnet selects a registered VLAN from a drop-down; a VLAN ID cannot be changed and a VLAN cannot be deleted while a subnet still references it, so prefixes never point at missing VLANs.

A subnet stores its CIDR, gateway, status (container, active, reserved, or deprecated), purpose, and VLAN. The subnet tree can be searched by name, CIDR, VLAN, or purpose and filtered by status. Addresses found in asset `address` fields are counted automatically, and you can also allocate or release IPs and link them to assets.

The IP addresses view combines manual allocations, asset addresses, and gateway addresses, with filters for subnet, source, status, and keyword. Manual allocations support status (active, reserved, deprecated, DHCP, or SLAAC), DNS name, role (loopback, secondary, VIP, VRRP, HSRP, GLBP, or anycast), linked asset, purpose, and notes, and can be edited or released.

- IPv4 `/8` through `/30`; partial overlaps are rejected, while a parent prefix may contain child prefixes;
- Asset addresses may contain multiple IPs separated by commas, semicolons, or spaces;
- Used addresses include the gateway, asset addresses, and manual allocations;
- The first 50 free addresses are listed, while the total free count is calculated from the subnet size;
- The gateway cannot be allocated again, and an address already present in an asset does not need a duplicate allocation;
- DNS names are validated as host names or fully qualified domain names;
- Subnet, VLAN, and IP allocation changes appear in change history with field-level differences.

## Data center layouts

Open the data center view (`数据中心`), create a named data center (a default grid is used), and add racks with a label, height, grid position, and orientation. Drag racks to vacant cells in the floor plan or edit their coordinates directly. The 3D overview supports rotation, zoom, rack selection, and opening device details.

Use the rack elevation to mount an existing asset or create and mount a physical host or switch in one step. Set the starting rack unit and device height. dc-db validates overlaps and rack boundaries. Asset details link back to the data center and rack, and virtual machines follow their host relationship. Unmounting a device keeps its asset record.

Racks occupy grid cells in the data center layout. The floor plan, rack elevation, and 3D overview share the same placement data. Data center, rack, and placement changes appear in change history.

## Back up and restore

Stop the web service before copying the SQLite file. The database uses WAL mode, and the last connection checkpoints the WAL into the main file on a clean exit. If `dc-db.db-wal` or `dc-db.db-shm` is still present, the process did not stop cleanly; start it again and stop it normally before taking the backup.

```bash
cp dc-db.db dc-db-backup.db
```

Verify a backup before relying on it. To restore, stop the service, replace the database file, remove any leftover `dc-db.db-wal` and `dc-db.db-shm`, and start the service again.

## Development

After each code change passes the relevant checks, build a release bundle using the Linux deployment steps above and update the user-designated remote development server through the configured SSH target `<dev-ssh-target>`. Stop the service before replacing artifacts, preserve the remote `config.yaml` and SQLite database, then install and start the service. Check `http://<dev-host>/healthz` and the main flow affected by the change. Keep real connection details and credentials in controlled, Git-ignored local configuration.

Do not start local or localhost services by default. Only when the user explicitly requests local debugging, after the first frontend build, use `npm --prefix web run dev` to start the frontend development server, which proxies `/api` to the Go service on port 8080. Start the Go service with `go run ./cmd/dc-db` and stop both services when debugging is complete. Run `go test ./...` for Go package checks and `npm --prefix web run check` for TypeScript type checking.

The schema lives in `internal/cmdb/schema.sql` and is applied when an empty database starts for the first time. This project is still in development: after changing the schema, delete the local `dc-db.db` and restart to recreate it; there are no migration files.

## License

Licensed under the [Apache License 2.0](LICENSE).
