# Easy CMDB

[简体中文](README.md)

Easy CMDB is a simple, easy-to-use configuration management database for IT assets, infrastructure configuration, and asset relationships. It targets small, single-node operations: around 3,000 virtual machines with a total footprint under 5,000 hosts, maintained by a small operations team. The design goal is simple, sufficient, and easy to maintain: no extra middleware and no large-cluster ambitions. It tracks physical hosts, virtual machines, and switches, with a home dashboard, asset search, relationship views, CSV import and export, IPAM subnet and address management, access controls, change history, and data center/rack views.

Easy CMDB uses Go, React 19 with TypeScript, Ant Design 6, ECharts, and SQLite. One Go binary, the built `web/dist` assets, and one SQLite file are all it needs; there is no separate database service to deploy. The current release uses SQLite, and a MySQL or PostgreSQL backend can be added later if needed.

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
go build -trimpath -o bin/easy ./cmd/easy
```

The SQLite database defaults to `easy.db` in the working directory. The first start creates the database file and schema automatically; there is no manual setup step. Start the web service:

```bash
./bin/easy serve
```

On Windows PowerShell:

```powershell
npm --prefix web ci
npm --prefix web run build
go build -trimpath -o bin/easy.exe ./cmd/easy
.\bin\easy.exe serve
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

- Leaving `admin.password` empty uses the default password `default`; change it to at least 12 bytes before exposing the service.
- Leaving both `operator` / `viewer` fields empty disables that account.
- Accounts are created only on first start; changing `config.yaml` later does not change an existing account's password.

## Asset management

Add individual assets with the `新增资产` button. For larger inventories, use CSV import: edit the file in Excel and save it as `CSV UTF-8` (comma-separated), click `下载模板` on the asset list to get the template, fill it in, then click `导入 CSV`.

Template columns:

```text
资源名称,类型,平台,状态,生命周期,地址 / IP,CPU,内存 MiB,负责人,环境,备注,扩展属性
```

- Type: `host`, `vm`, `switch`, or the Chinese labels 物理机, 虚拟机, 交换机.
- Platform: `pve`, `kvm`, `Proxmox VE`, `KVM`, or empty.
- Status: `unknown`, `online`, `offline`, `running`, `stopped`, `paused`, or the Chinese labels 未知, 在线, 离线, 运行中, 已停止, 已暂停.
- Lifecycle: `active`, `retired`, 在册, 已退役; empty defaults to active.
- Attributes: a JSON object such as `{"位置":"A01"}`; empty becomes `{}`.
- CPU and memory MiB must be non-negative integers.

Import rules:

- Up to 5,000 rows and 16 MiB per import;
- Validation and insert run in one batch; if any row fails, nothing is written;
- Import only creates new assets; it never overwrites an existing asset;
- Asset names must not duplicate an existing asset or another row in the same file;
- Successful imports appear in change history under the current account.

Exported CSV files use the same columns and can be used as a reference when preparing an import.

## IP address management

Add a subnet with its CIDR, gateway, and VLAN under `IPAM`. Addresses found in asset `address` fields are counted automatically, and you can also allocate or release IPs and link them to assets.

- IPv4 `/8` through `/30`; overlapping subnets are rejected;
- Asset addresses may contain multiple IPs separated by commas, semicolons, or spaces;
- Used addresses include the gateway, asset addresses, and manual allocations;
- The first 50 free addresses are listed, while the total free count is calculated from the subnet size;
- The gateway cannot be allocated again, and an address already present in an asset does not need a duplicate allocation;
- Subnet and IP allocation changes appear in change history.

## Data center layouts

Open the data center view (`数据中心`), create a named data center with a grid size, and add racks with a label, height, grid position, and orientation. Drag racks to vacant cells in the floor plan or edit their coordinates directly. The 3D overview supports rotation, zoom, rack selection, and opening device details.

Use the rack elevation to mount an existing asset or create and mount a physical host or switch in one step. Set the starting rack unit and device height. Easy CMDB validates overlaps and rack boundaries. Asset details link back to the data center and rack, and virtual machines follow their host relationship. Unmounting a device keeps its asset record.

Racks occupy grid cells in the data center layout. The floor plan, rack elevation, and 3D overview share the same placement data. Data center, rack, and placement changes appear in change history.

## Back up and restore

Stop the web service before copying the SQLite file. The database uses WAL mode, and the last connection checkpoints the WAL into the main file on a clean exit. If `easy.db-wal` or `easy.db-shm` is still present, the process did not stop cleanly; start it again and stop it normally before taking the backup.

```bash
cp easy.db easy-cmdb.db
```

Verify a backup before relying on it. To restore, stop the service, replace the database file, remove any leftover `easy.db-wal` and `easy.db-shm`, and start the service again.

## Development

After the first frontend build, `npm --prefix web run dev` starts the frontend development server and proxies `/api` to the Go service on port 8080. Run the Go service with `go run ./cmd/easy`. Run `go test ./...` for Go package checks and `npm --prefix web run check` for TypeScript type checking.

The schema lives in `internal/cmdb/schema.sql` and is applied when an empty database starts for the first time. This project is still in development: after changing the schema, delete the local `easy.db` and restart to recreate it; there are no migration files.

## License

Licensed under the [Apache License 2.0](LICENSE).
