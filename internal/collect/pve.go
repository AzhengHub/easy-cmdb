package collect

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"radar-cmdb/internal/cmdb"
)

type pveResource struct {
	Type   string `json:"type"`
	Node   string `json:"node"`
	Name   string `json:"name"`
	Status string `json:"status"`
	VMID   int    `json:"vmid"`
	CPU    int    `json:"maxcpu"`
	Memory int64  `json:"maxmem"`
	Disk   int64  `json:"maxdisk"`
}

type pveAPI struct {
	base  string
	token string
	http  *http.Client
}

func openPVE(source Source) (*pveAPI, error) {
	endpoint, err := url.Parse(source.Endpoint)
	if err != nil || endpoint.Scheme != "https" || endpoint.Hostname() == "" || endpoint.User != nil ||
		endpoint.RawQuery != "" || endpoint.Fragment != "" || strings.Trim(endpoint.Path, "/") != "" {
		return nil, errors.New("PVE endpoint 须为 HTTPS 节点地址，例如 https://pve.example:8006")
	}
	token := strings.TrimSpace(os.Getenv(source.TokenEnv))
	if token == "" || strings.ContainsAny(token, "\r\n") {
		return nil, errors.New("PVE Token 环境变量缺失或格式无效")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	if source.CAFile != "" {
		root, err := x509.SystemCertPool()
		if err != nil {
			return nil, errors.New("读取系统证书失败")
		}
		pem, err := os.ReadFile(source.CAFile)
		if err != nil || !root.AppendCertsFromPEM(pem) {
			return nil, errors.New("读取 PVE CA 证书失败")
		}
		transport.TLSClientConfig.RootCAs = root
	}
	return &pveAPI{
		base: strings.TrimRight(endpoint.String(), "/") + "/api2/json", token: token,
		http: &http.Client{
			Transport: transport, Timeout: 15 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
}

func (api *pveAPI) get(ctx context.Context, path string, output any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, api.base+path, nil)
	if err != nil {
		return errors.New("无法创建 PVE 请求")
	}
	req.Header.Set("Authorization", "PVEAPIToken="+api.token)
	res, err := api.http.Do(req)
	if err != nil {
		return fmt.Errorf("请求 PVE %s 失败，请检查网络和证书", path)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("PVE %s 返回 HTTP %d，请检查接口权限和节点状态", path, res.StatusCode)
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	err = json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(&envelope)
	if err != nil || len(envelope.Data) == 0 || string(envelope.Data) == "null" {
		return fmt.Errorf("PVE %s 响应格式无效", path)
	}
	if err := json.Unmarshal(envelope.Data, output); err != nil {
		return fmt.Errorf("PVE %s 数据格式无效", path)
	}
	return nil
}

func pveSnapshot(ctx context.Context, source Source) (cmdb.Snapshot, error) {
	api, err := openPVE(source)
	if err != nil {
		return cmdb.Snapshot{}, err
	}
	defer api.http.CloseIdleConnections()
	var resources []pveResource
	if err := api.get(ctx, "/cluster/resources", &resources); err != nil {
		return cmdb.Snapshot{}, err
	}

	var snapshot cmdb.Snapshot
	snapshot.Assets = append(snapshot.Assets, cmdb.Observation{
		Key: "cluster", Kind: "cluster", Name: source.Name, Status: "unknown",
	})
	nodes := make(map[string]bool)
	for _, item := range resources {
		if item.Type != "node" || item.Node == "" {
			continue
		}
		key := "node/" + item.Node
		nodes[item.Node] = true
		snapshot.Assets = append(snapshot.Assets, cmdb.Observation{
			Key: key, Kind: "host", Name: item.Node, Status: knownStatus(item.Status),
			CPU: item.CPU, MemoryMiB: item.Memory / (1 << 20),
		})
		snapshot.Links = append(snapshot.Links, cmdb.ObservedLink{FromKey: "cluster", ToKey: key, Kind: "member"})
	}
	if len(nodes) == 0 {
		return cmdb.Snapshot{}, errors.New("PVE 返回空节点清单，请检查 Token 的节点审计权限")
	}

	for _, item := range resources {
		if item.Type != "qemu" {
			continue
		}
		if item.VMID < 1 || !nodes[item.Node] {
			return cmdb.Snapshot{}, errors.New("PVE 虚拟机缺少有效 VMID 或宿主机")
		}
		id := strconv.Itoa(item.VMID)
		key := "qemu/" + id
		if item.Name == "" {
			item.Name = "VM " + id
		}
		details := map[string]any{"VMID": item.VMID}
		if item.Disk > 0 {
			details["磁盘容量（GiB）"] = float64(item.Disk) / (1 << 30)
		}
		if source.VMDetails {
			if err := fetchPVEVMConfig(ctx, api, item, details); err != nil {
				return cmdb.Snapshot{}, err
			}
		}
		body, err := json.Marshal(details)
		if err != nil {
			return cmdb.Snapshot{}, err
		}
		snapshot.Assets = append(snapshot.Assets, cmdb.Observation{
			Key: key, Kind: "vm", Name: item.Name, Status: knownStatus(item.Status),
			CPU: item.CPU, MemoryMiB: item.Memory / (1 << 20), Details: body,
		})
		snapshot.Links = append(snapshot.Links, cmdb.ObservedLink{FromKey: "node/" + item.Node, ToKey: key, Kind: "hosts"})
	}
	return snapshot, nil
}

var pveDevice = regexp.MustCompile(`^(net|scsi|sata|virtio|ide)[0-9]+$`)

func fetchPVEVMConfig(ctx context.Context, api *pveAPI, item pveResource, details map[string]any) error {
	path := fmt.Sprintf("/nodes/%s/qemu/%d/config", url.PathEscape(item.Node), item.VMID)
	var config map[string]json.RawMessage
	if err := api.get(ctx, path, &config); err != nil {
		return err
	}
	devices := make(map[string]string)
	for name, value := range config {
		var text string
		if json.Unmarshal(value, &text) != nil {
			continue
		}
		switch {
		case name == "smbios1":
			for _, option := range strings.Split(text, ",") {
				if key, val, ok := strings.Cut(option, "="); ok && key == "uuid" {
					details["标识"] = strings.ToLower(val)
				}
			}
		case pveDevice.MatchString(name):
			devices[name] = text
		}
	}
	if len(devices) != 0 {
		details["虚拟设备"] = devices
	}
	return nil
}

func knownStatus(status string) string {
	switch status {
	case "online", "offline", "running", "stopped", "paused":
		return status
	default:
		return "unknown"
	}
}
