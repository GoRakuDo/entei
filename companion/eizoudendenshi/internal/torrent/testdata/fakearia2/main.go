// Command fakearia2 is a deterministic stand-in for the aria2 helper used
// by the ED-2G torrent job tests. It never touches a swarm or the network.
//
// Behavior is controlled entirely by environment variables so the manager's
// fixed argument vector stays untouched:
//
//	EIZOU_FAKE_ARGS_OUT     — path to write the received argv (one per line)
//	EIZOU_FAKE_TORRENT      — torrent spec: "files=a.mp4:6000|b.srt:100;pieceLen=1000"
//	EIZOU_FAKE_METADATA     — "1": write only the .torrent metadata, exit 0
//	EIZOU_FAKE_PAYLOAD      — "1": write the --select-file file's verified
//	                          head pieces (deterministic content), holes
//	                          elsewhere; exit 0
//	EIZOU_FAKE_HEAD_PIECES  — how many head pieces of the selected file to write
//	EIZOU_FAKE_FAIL         — "1": exit 2 after writing
//	EIZOU_FAKE_HOLD         — "1": after writing, hold forever
//	EIZOU_FAKE_DELAY_MS     — delay between pieces (slow download simulation)
//
// Piece content is deterministic: global piece i's bytes are the SHA-1 of
// "piece-<i>" repeated to the piece length, so the metadata hashes and the
// payload bytes always agree.
package main

import (
	"bytes"
	"crypto/sha1"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func mustInt(name string) int {
	s := os.Getenv(name)
	if s == "" {
		return 0
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}

type fileSpec struct {
	Name   string
	Length int64
}

func parseSpec() (files []fileSpec, pieceLen int64) {
	spec := os.Getenv("EIZOU_FAKE_TORRENT")
	head, pl, _ := strings.Cut(spec, ";pieceLen=")
	pieceLen, _ = strconv.ParseInt(pl, 10, 64)
	if pieceLen <= 0 {
		pieceLen = 1000
	}
	head = strings.TrimPrefix(head, "files=")
	for _, f := range strings.Split(head, "|") {
		if f == "" {
			continue
		}
		parts := strings.SplitN(f, ":", 2)
		if len(parts) != 2 {
			continue
		}
		n, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || n < 0 {
			continue
		}
		files = append(files, fileSpec{Name: parts[0], Length: n})
	}
	return
}

func pieceBytes(i int64, pieceLen int64) []byte {
	sum := sha1.Sum([]byte(fmt.Sprintf("piece-%d", i)))
	out := make([]byte, pieceLen)
	start := int64(0)
	if i == 0 && pieceLen >= 256 {
		// Piece 0 carries a fake faststart MP4 header (ftyp + moov) so the
		// manager's conservative container sniff accepts it once verified.
		hdr := []byte{0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 0, 0}
		hdr = append(hdr, []byte("moov")...)
		copy(out, hdr)
		start = 20
	}
	for off := start; off < pieceLen; off += 20 {
		copy(out[off:], sum[:])
	}
	return out
}

func bstr(s string) []byte { return []byte(strconv.Itoa(len(s)) + ":" + s) }
func bint(n int64) []byte  { return []byte("i" + strconv.FormatInt(n, 10) + "e") }

func encodeTorrent(files []fileSpec, pieceLen int64) []byte {
	var pieces bytes.Buffer
	var total int64
	for _, f := range files {
		total += f.Length
	}
	for i := int64(0); i*pieceLen < total; i++ {
		h := sha1.Sum(pieceBytes(i, pieceLen))
		pieces.Write(h[:])
	}
	var info bytes.Buffer
	info.WriteString("d")
	if len(files) == 1 {
		info.Write(bstr("length"))
		info.Write(bint(files[0].Length))
	} else {
		var total int64
		for _, f := range files {
			total += f.Length
		}
		info.Write(bstr("length"))
		info.Write(bint(total))
	}
	info.Write(bstr("name"))
	if len(files) == 1 {
		info.Write(bstr(files[0].Name))
	} else {
		info.Write(bstr("fixture"))
	}
	info.Write(bstr("piece length"))
	info.Write(bint(pieceLen))
	info.Write(bstr("pieces"))
	info.Write(bstr(pieces.String()))
	if len(files) == 1 {
		info.WriteString("e")
		out := append([]byte("d"), append(bstr("info"), info.Bytes()...)...)
		return append(out, 'e')
	}
	info.Write(bstr("files"))
	info.WriteString("l")
	for _, f := range files {
		info.WriteString("d")
		info.Write(bstr("length"))
		info.Write(bint(f.Length))
		info.Write(bstr("path"))
		info.WriteString("l")
		info.Write(bstr(f.Name))
		info.WriteString("ee")
	}
	info.WriteString("ee")
	out := append([]byte("d"), append(bstr("info"), info.Bytes()...)...)
	return append(out, 'e')
}

func main() {
	args := os.Args[1:]
	if out := os.Getenv("EIZOU_FAKE_ARGS_OUT"); out != "" {
		_ = os.WriteFile(out, []byte(strings.Join(args, "\n")), 0o600)
	}
	dir := ""
	selectIdx := 0
	for i, a := range args {
		if strings.HasPrefix(a, "--dir=") {
			dir = strings.TrimPrefix(a, "--dir=")
		}
		if strings.HasPrefix(a, "--select-file=") {
			selectIdx, _ = strconv.Atoi(strings.TrimPrefix(a, "--select-file="))
		}
		_ = i
	}
	if dir == "" {
		os.Exit(3)
	}
	files, pieceLen := parseSpec()

	// Mode dispatch by ARGV (the manager reuses the same env for both
	// phases): --select-file ⇒ payload; otherwise metadata (if requested).
	if selectIdx > 0 {
		if selectIdx < 1 || selectIdx > len(files) {
			os.Exit(4)
		}
		tf := files[selectIdx-1]
		var start int64
		for _, f := range files[:selectIdx-1] {
			start += f.Length
		}
		head := int64(mustInt("EIZOU_FAKE_HEAD_PIECES"))
		delay := mustInt("EIZOU_FAKE_DELAY_MS")
		p := filepath.Join(dir, filepath.FromSlash(tf.Name))
		_ = os.MkdirAll(filepath.Dir(p), 0o700)
		f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			os.Exit(5)
		}
		// Write only the head pieces that lie FULLY inside the file (holes
		// elsewhere — the file is the full size on disk, never availability).
		for i := int64(0); i < head; i++ {
			pieceStart := i * pieceLen
			pieceEnd := pieceStart + pieceLen
			if pieceStart < start || pieceEnd > start+tf.Length {
				continue
			}
			if _, err := f.WriteAt(pieceBytes(i, pieceLen), pieceStart-start); err != nil {
				break
			}
			if delay > 0 {
				time.Sleep(time.Duration(delay) * time.Millisecond)
			}
		}
		_ = f.Close()
		// The file must exist at its FULL size on disk (aria2 preallocates
		// to the piece offsets); the unwritten tail is holes — never
		// availability. Only the manager's hash verification decides what
		// is servable.
		if st, err := os.Stat(p); err == nil && st.Size() < tf.Length {
			_ = os.Truncate(p, tf.Length)
		}
		if os.Getenv("EIZOU_FAKE_FAIL") == "1" {
			os.Exit(2)
		}
		if os.Getenv("EIZOU_FAKE_HOLD") == "1" {
			for {
				time.Sleep(100 * time.Millisecond)
			}
		}
		os.Exit(0)
	}

	if os.Getenv("EIZOU_FAKE_METADATA") == "1" {
		if os.Getenv("EIZOU_FAKE_FAIL") == "1" {
			os.Exit(2)
		}
		_ = os.WriteFile(filepath.Join(dir, "fixture.torrent"), encodeTorrent(files, pieceLen), 0o600)
		os.Exit(0)
	}

	os.Exit(3)
}
