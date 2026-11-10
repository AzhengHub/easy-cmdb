# Contributing

LinkCMDB is currently maintained by a single developer. Issues and pull requests are welcome, but reviews may take a few days.

## Development setup

Requirements: Go 1.26+ and Node.js 22 LTS.

```bash
npm --prefix web ci
npm --prefix web run build
go build -trimpath -o bin/linkcmdb ./cmd/linkcmdb
./bin/linkcmdb serve
```

The service listens on `127.0.0.1:8080`. The SQLite database defaults to `linkcmdb.db` in the working directory. Copy `config.example.yaml` to `config.yaml` to change the listen address, the database path, or the bootstrap accounts; `config.yaml` is ignored by Git.

## Checks

Run these before sending a change:

```bash
gofmt -l .          # must print nothing
go vet ./...
go test ./...
npm --prefix web run check
npm --prefix web run build
```

## Guidelines

- Keep commits small and use English conventional-commit messages, for example `feat(api): add subnet search`.
- Do not include real hostnames, IP addresses, credentials, or asset exports in code, tests, issues, or screenshots. Use documentation ranges such as `192.0.2.0/24`.
- Schema changes edit `internal/cmdb/schema.sql` directly. The project is pre-1.0 and does not ship migrations yet.
- Update both `README.md` and `README.en.md` when deployment or configuration changes.
- Front-end changes must work in both the light and the dark theme.

## License

By contributing you agree that your contribution is licensed under the Apache License 2.0; see `LICENSE`.
