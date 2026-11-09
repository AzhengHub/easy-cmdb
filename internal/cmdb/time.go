package cmdb

import "time"

// timestampLayout is the fixed, lexicographically sortable format used for all
// stored timestamps. Keeping a fixed width and a trailing Z lets SQLite compare
// timestamps as text, which is how session expiry and sync leases are checked.
const timestampLayout = "2006-01-02T15:04:05Z07:00"

func nowText() string {
	return time.Now().UTC().Format(timestampLayout)
}

func timeText(t time.Time) string {
	return t.UTC().Format(timestampLayout)
}
