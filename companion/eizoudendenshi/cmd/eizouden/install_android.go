//go:build android

// Android (Termux) DNS resolver installation.
//
// CGO_ENABLED=0 pure-Go builds cannot resolve host names on Android: Go's
// resolver reads /etc/resolv.conf (absent in Termux) and neither the OS
// resolver nor Android's netd is reachable, so lookups fail — the DHT
// "starting nodes: nothing resolved" symptom (dht_nodes=0,
// announce_tried=0 in the engine diagnostics) and the updater's "could
// not check for updates". curl works because it uses the system resolver.
//
// The fix installs a PreferGo resolver that connects to its own
// nameservers: the Termux resolv.conf nameservers when the file exists,
// otherwise 1.1.1.1:53. Non-Android builds keep the default resolver
// (see install_other.go). The nameserver parser lives in dns_common.go
// (build-tag-free so it is unit-testable everywhere).
package main

import (
	"context"
	"net"
)

// termuxResolvConf is Termux's resolv.conf ($PREFIX/etc/resolv.conf).
// When present its nameservers match the device's actual network; using
// exactly those keeps DNS on the LAN.
const termuxResolvConf = "/data/data/com.termux/files/usr/etc/resolv.conf"

// fallbackResolverAddr is the nameserver used when the Termux resolv.conf
// is missing or unreadable: without a nameserver the companion would
// resolve nothing at all (DHT bootstrap, update feed, trackers). 1.1.1.1
// is the public Cloudflare recursive resolver.
const fallbackResolverAddr = "1.1.1.1:53"

// dial connects to the fixed nameserver address; the resolver-requested
// address is irrelevant (DNS is connectionless over UDP — which server we
// dial is what matters).
func (ns nameserver) dial(ctx context.Context, network string) (net.Conn, error) {
	return ns.dialer.DialContext(ctx, network, ns.addr)
}

// installAndroidDNSResolver replaces net.DefaultResolver with a PreferGo
// resolver that connects to the Termux resolv.conf nameservers (or the
// fallback 1.1.1.1:53). Multiple nameservers are tried in order. The
// fallback is always available: when the resolv.conf cannot be read only
// the fallback is used.
func installAndroidDNSResolver() {
	servers := readNameservers(termuxResolvConf)
	if len(servers) == 0 {
		servers = []nameserver{newNameserver(fallbackResolverAddr)}
	}
	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var lastErr error
			for _, ns := range servers {
				conn, err := ns.dial(ctx, network)
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			return nil, lastErr
		},
	}
}
