// DNS resolver plumbing shared across platforms.
//
// readNameservers is used by the Android (Termux) resolver installation
// (install_android.go) and is kept in a build-tag-free file so it can be
// unit-tested on any platform (including Windows). Other platforms do not
// call it (install_other.go is a no-op).
package main

import (
	"bufio"
	"net"
	"os"
	"strings"
	"time"
)

// nameserver pairs a fixed DNS endpoint with a dialer that connects to it
// (the resolver's requested address is ignored — every DNS query goes to
// this exact server).
type nameserver struct {
	addr   string
	dialer net.Dialer
}

func newNameserver(addr string) nameserver {
	return nameserver{addr: addr, dialer: net.Dialer{Timeout: 3 * time.Second}}
}

// readNameservers parses nameserver lines from a resolv.conf-style file.
// Comment lines (#, ;) and whitespace-only lines are skipped; malformed
// lines are ignored. Returns nil when the file is missing or unreadable.
func readNameservers(path string) []nameserver {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []nameserver
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == "nameserver" {
			// net.JoinHostPort brackets IPv6 addresses; a plain IPv4 is
			// left as-is.
			out = append(out, newNameserver(net.JoinHostPort(fields[1], "53")))
		}
	}
	return out
}
