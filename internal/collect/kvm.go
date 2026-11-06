package collect

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"radar-cmdb/internal/cmdb"
)

var uuidPattern = regexp.MustCompile(`(?i)^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$`)

func kvmSnapshot(ctx context.Context, source Source) (cmdb.Snapshot, error) {
	uri, err := url.Parse(source.Endpoint)
	if err != nil || uri.RawQuery != "" || uri.Fragment != "" || uri.Opaque != "" {
		return cmdb.Snapshot{}, errors.New("KVM 连接地址格式无效")
	}
	if uri.Scheme == "qemu+ssh" && uri.Hostname() != "" && uri.User != nil && uri.Path == "/system" {
		if _, hasPassword := uri.User.Password(); hasPassword {
			return cmdb.Snapshot{}, errors.New("KVM URI 须使用 SSH 密钥登录")
		}
		uri.RawQuery = "no_tty=1"
	} else if source.Endpoint != "qemu:///system" && source.Endpoint != "test:///default" {
		return cmdb.Snapshot{}, errors.New("KVM endpoint 须为 qemu+ssh://user@host/system 或 qemu:///system")
	}

	return readVirshInventory(ctx, source.Name, uri.String())
}

func readVirshInventory(ctx context.Context, name, uri string) (cmdb.Snapshot, error) {
	info, err := virsh(ctx, uri, "nodeinfo")
	if err != nil {
		return cmdb.Snapshot{}, err
	}
	host := parseVirshFields(info)
	snapshot := cmdb.Snapshot{Assets: []cmdb.Observation{{
		Key: "host", Kind: "host", Name: name, Status: "online",
		CPU: firstInteger(host["CPU(s)"]), MemoryMiB: int64(firstInteger(host["Memory size"])) / 1024,
	}}}
	list, err := virsh(ctx, uri, "list --all --uuid")
	if err != nil {
		return cmdb.Snapshot{}, err
	}
	ids := strings.Fields(list)
	if len(ids) == 0 {
		return snapshot, nil
	}
	commands := make([]string, 0, len(ids))
	for _, id := range ids {
		if !uuidPattern.MatchString(id) {
			return cmdb.Snapshot{}, errors.New("virsh 返回了无效的虚拟机 UUID")
		}
		commands = append(commands, "dominfo "+id)
	}
	output, err := virsh(ctx, uri, strings.Join(commands, "; "))
	if err != nil {
		return cmdb.Snapshot{}, err
	}
	domains := make(map[string]map[string]string, len(ids))
	for _, block := range strings.Split("\n"+output, "\nId:") {
		fields := parseVirshFields(block)
		if uuidPattern.MatchString(fields["UUID"]) {
			domains[strings.ToLower(fields["UUID"])] = fields
		}
	}
	for _, id := range ids {
		uuid := strings.ToLower(id)
		vm, ok := domains[uuid]
		if !ok || vm["Name"] == "" {
			return cmdb.Snapshot{}, fmt.Errorf("virsh 返回的虚拟机 %s 信息不完整", id)
		}
		details, err := json.Marshal(map[string]string{"标识": uuid, "来宾类型": vm["OS Type"]})
		if err != nil {
			return cmdb.Snapshot{}, err
		}
		status := vm["State"]
		if status == "shut off" || status == "shutdown" {
			status = "stopped"
		}
		key := "domain/" + uuid
		snapshot.Assets = append(snapshot.Assets, cmdb.Observation{
			Key: key, Kind: "vm", Name: vm["Name"], Status: knownStatus(status),
			CPU: firstInteger(vm["CPU(s)"]), MemoryMiB: int64(firstInteger(vm["Max memory"])) / 1024, Details: details,
		})
		snapshot.Links = append(snapshot.Links, cmdb.ObservedLink{FromKey: "host", ToKey: key, Kind: "hosts"})
	}
	return snapshot, nil
}

func virsh(ctx context.Context, uri, command string) (string, error) {
	cmd := exec.CommandContext(ctx, "virsh", "--readonly", "--quiet", "--connect", uri, command)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("virsh %s 查询失败，请检查 libvirt、SSH 密钥与 known_hosts", strings.Fields(command)[0])
	}
	return string(output), nil
}

func parseVirshFields(text string) map[string]string {
	fields := make(map[string]string)
	for _, line := range strings.Split(text, "\n") {
		key, value, ok := strings.Cut(line, ":")
		if ok {
			fields[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	return fields
}

func firstInteger(text string) int {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return 0
	}
	number, _ := strconv.Atoi(fields[0])
	return number
}
