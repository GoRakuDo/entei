// Command eizouden is the EizouDendenshi loopback companion.
//
// It binds a loopback-only HTTP API, prints its resolved bound address and a
// freshly generated 6-digit pairing code to the terminal, then serves the
// /v1 API. Pairing code and capability token live only in process memory;
// nothing is written to disk, storage, or logs. With --fixture, a single
// media file is served at /v1/media/fixture with byte Range semantics.
package main

import (
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"eizoudendenshi/internal/api"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:0",
		"loopback bind address host:port (default port 0 = ephemeral)")
	fixture := flag.String("fixture", "",
		"path to a media file served at /v1/media/fixture (ED-2B PoC; "+
			"empty = media endpoint disabled)")
	flag.Parse()

	bind, err := resolveBindAddress(*addr)
	if err != nil {
		log.Fatalf("invalid --addr: %v", err)
	}

	if *fixture != "" {
		// Fail fast at startup if the configured fixture is unusable.
		// The HTTP endpoint itself never discloses paths.
		st, err := os.Stat(*fixture)
		if err != nil {
			log.Fatalf("--fixture: %v", err)
		}
		if st.IsDir() {
			log.Fatalf("--fixture: %q is a directory; a single file is required", *fixture)
		}
	}

	srv, err := api.New(api.Config{FixturePath: *fixture})
	if err != nil {
		log.Fatalf("init api: %v", err)
	}

	ln, err := net.Listen("tcp", bind)
	if err != nil {
		log.Fatalf("listen on %s: %v", bind, err)
	}

	// Terminal-only handoff. The pairing code is printed on purpose; the
	// capability token is never printed or logged.
	fmt.Fprintf(os.Stdout, "EizouDendenshi ED-2B (%s) listening on http://%s\n",
		api.Version, ln.Addr())
	fmt.Fprintf(os.Stdout, "Pairing code: %s\n", srv.PairingCode())
	if *fixture == "" {
		fmt.Fprintln(os.Stdout, "Media fixture: disabled (--fixture not set)")
	} else {
		fmt.Fprintf(os.Stdout, "Media fixture: enabled (%s)\n", filepath.Base(*fixture))
	}

	if err := http.Serve(ln, srv.Handler()); err != nil &&
		!errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// resolveBindAddress enforces the loopback-only binding policy. Only literal
// loopback IPs are accepted: IPv4 127.0.0.0/8 (net.IP.IsLoopback) and IPv6
// ::1. Hostnames — including "localhost" — and the empty host (":port", which
// binds all interfaces) are rejected. The port must be a valid numeric port
// (0–65535; 0 = ephemeral for this PoC).
func resolveBindAddress(addr string) (string, error) {
	if addr == "" {
		return "", errors.New("empty address")
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "", fmt.Errorf("invalid host:port: %w", err)
	}
	if host == "" {
		return "", errors.New("empty host binds all interfaces; use a literal loopback IP (e.g. 127.0.0.1)")
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return "", fmt.Errorf("host %q is not a literal loopback IP", host)
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 0 || n > 65535 {
		return "", fmt.Errorf("invalid port %q", port)
	}
	return addr, nil
}
