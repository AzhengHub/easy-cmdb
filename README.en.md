# Radar CMDB

[简体中文](README.md)

Radar CMDB helps enterprises manage IT assets, infrastructure configuration, and business relationships in one place. It tracks physical hosts, chassis and compute nodes, virtualization clusters, and virtual machines. The web interface provides asset search, relationship views, CSV export, access controls, and change history, with read-only discovery for Proxmox VE and standalone KVM.

Radar uses Go, Vue 3 with TypeScript, and PostgreSQL. The web interface currently uses Simplified Chinese. English localization is planned once the first release's features and terminology settle.

## Quick start

Install Docker and Docker Compose v2.24 or later. Copy the example configuration:

```bash
cp .env.example .env
```

Run `openssl rand -hex 24` to generate a database password and set `POSTGRES_PASSWORD` in `.env`. Start the services:

```bash
docker compose up --build -d
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080). The default local sign-in is `admin` with password `default`. A new installation starts with an empty inventory. Add assets in the web interface or configure a data source below.

Compose binds the web interface to localhost by default. Before the first start of a network-accessible installation, set a unique `RADAR_ADMIN_PASSWORD` of at least 12 bytes. Set a password as well if you customize `RADAR_ADMIN_USER`. Set `RADAR_COOKIE_SECURE=true` when serving the application through an HTTPS reverse proxy. Use a hexadecimal database password to keep the connection URL easy to configure. Account environment variables apply when an account is first created. Existing accounts use their stored passwords.

## Connect Proxmox VE and standalone KVM

1. Create `collector-data/ssh` and copy [collectors.example.json](collectors.example.json) to `collector-data/sources.json`. Add one source per Proxmox VE cluster and one per standalone libvirt host. Give every source a unique, stable `key`.
2. For Proxmox VE, grant the collection account and API token read access to the resources to inventory. With token privilege separation enabled, assign the required permissions to both the user and the token. Set the variable named by `tokenEnv` in `collector-data/credentials.env`, for example `RADAR_PVE_TOKEN='radar@pve!inventory=<token secret>'`. Provide the cluster CA at the path specified by `caFile` and use a node hostname that matches its certificate. The collector reads the cluster resource inventory. Enable `vmDetails` to also read virtual NICs, disk references, and available VM identifiers.
3. For KVM, the collector connects to libvirt over SSH with `virsh --readonly`. Put the dedicated private key and a verified `known_hosts` file in `collector-data/ssh/`. Add an SSH `config` if needed. The container runs as UID 10001, so make the files readable by that user and restrict private-key access to the file owner. A collector running directly on the host can also use `qemu:///system`.
4. Start the collector and open the collection status page (`采集状态`) to see the results.

```bash
docker compose --profile collect up -d
docker compose --profile collect logs collector
```

To run one collection cycle, use `docker compose --profile collect run --rm collector collect --once`. Each source runs one cycle at a time.

The collector updates resource names, CPU, memory, status, and virtualization relationships. Operators maintain ownership, business associations, environment, management addresses, and custom attributes. Two consecutive successful syncs that fail to find a resource mark it for review. An operator confirms retirement. A failed sync preserves the last successful inventory. VM migrations within a Proxmox VE cluster retain the asset ID, and change history records when the collector observed the move. When setting up a new installation with existing infrastructure, run collection first, then attach chassis relationships and business ownership to the discovered assets.

The current collector covers Proxmox VE QEMU virtual machines and libvirt domains. Guest IPs and hardware serial numbers can be entered manually. Planned work includes iDRAC/Redfish, guest-agent IP discovery, CSV import, and reconciling KVM migrations across data sources.

## Back up and restore

Run a logical backup daily and copy the resulting dump to separate storage.

```bash
docker compose exec -T db pg_dump -U radar -d radar -Fc > radar-cmdb.dump
```

Verify the backup in a separate empty database before using it for recovery. These commands create a verification database alongside the original:

```bash
docker compose exec -T db createdb -U radar radar_restore
docker compose exec -T db pg_restore -U radar --exit-on-error -d radar_restore < radar-cmdb.dump
```

## Development

Use Go 1.26 or later, Node.js 22 LTS or another version supported by Vite 7, and a separate PostgreSQL 17 development database.

```bash
npm --prefix web ci
npm --prefix web run build
export RADAR_DATABASE_URL='postgres://radar:<password>@127.0.0.1:5432/radar?sslmode=disable'
export RADAR_ADMIN_PASSWORD='<at-least-12-bytes>'
go run ./cmd/radar
```

Run `go test ./...` for Go package checks and `npm --prefix web run check` for Vue type checking. With the Go server running on port 8080, `npm --prefix web run dev` starts the frontend development server and proxies `/api` to Go. The API and collector share the same binary and run separately as `radar serve` and `radar collect`.

## License

Licensed under the [Apache License 2.0](LICENSE).
