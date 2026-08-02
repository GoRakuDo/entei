package torrent

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Bencode parsing (stdlib only; no external library) — enough to read the
// info dict of the aria2-saved .torrent: file list, lengths, piece length,
// and the SHA-1 piece hashes. Any malformed or unsafe structure fails
// closed; nothing here ever echoes magnet/tracker data.

type bvalue struct {
	typ byte // 'i' int, 's' string, 'l' list, 'd' dict
	i   int64
	s   []byte
	l   []bvalue
	d   map[string]bvalue
}

func parseBencode(data []byte) (bvalue, error) {
	v, next, err := parseBValue(data, 0)
	if err != nil {
		return bvalue{}, err
	}
	if next != len(data) {
		return bvalue{}, errors.New("trailing bytes after bencode value")
	}
	return v, nil
}

func parseBValue(data []byte, at int) (bvalue, int, error) {
	if at >= len(data) {
		return bvalue{}, at, errors.New("unexpected end of bencode data")
	}
	switch data[at] {
	case 'i':
		end := bytes.IndexByte(data[at:], 'e')
		if end < 0 {
			return bvalue{}, at, errors.New("unterminated bencode integer")
		}
		raw := string(data[at+1 : at+end])
		if raw == "" || raw[0] == '-' && len(raw) == 1 {
			return bvalue{}, at, errors.New("invalid bencode integer")
		}
		var n int64
		if _, err := fmt.Sscan(raw, &n); err != nil {
			return bvalue{}, at, errors.New("invalid bencode integer")
		}
		return bvalue{typ: 'i', i: n}, at + end + 1, nil
	case 'l':
		v := bvalue{typ: 'l'}
		i := at + 1
		for {
			if i >= len(data) {
				return bvalue{}, at, errors.New("unterminated bencode list")
			}
			if data[i] == 'e' {
				return v, i + 1, nil
			}
			item, ni, err := parseBValue(data, i)
			if err != nil {
				return bvalue{}, at, err
			}
			v.l = append(v.l, item)
			i = ni
		}
	case 'd':
		v := bvalue{typ: 'd', d: map[string]bvalue{}}
		i := at + 1
		for {
			if i >= len(data) {
				return bvalue{}, at, errors.New("unterminated bencode dict")
			}
			if data[i] == 'e' {
				return v, i + 1, nil
			}
			key, ni, err := parseBValue(data, i)
			if err != nil || key.typ != 's' {
				return bvalue{}, at, errors.New("invalid bencode dict key")
			}
			val, nv, err := parseBValue(data, ni)
			if err != nil {
				return bvalue{}, at, err
			}
			v.d[string(key.s)] = val
			i = nv
		}
	default:
		colon := bytes.IndexByte(data[at:], ':')
		if colon < 0 {
			return bvalue{}, at, errors.New("invalid bencode string")
		}
		var n int
		if _, err := fmt.Sscan(string(data[at:at+colon]), &n); err != nil || n < 0 {
			return bvalue{}, at, errors.New("invalid bencode string length")
		}
		start := at + colon + 1
		if start+n > len(data) {
			return bvalue{}, at, errors.New("bencode string exceeds data")
		}
		return bvalue{typ: 's', s: data[start : start+n]}, start + n, nil
	}
}

// TorrentFile is one file inside the torrent, sanitized for the API.
type TorrentFile struct {
	Index  int    // 1-based aria2 --select-file index
	Path   string // sanitized relative path (components joined with '/')
	Length int64
}

// TorrentMetadata is the parsed info dict of the saved .torrent.
type TorrentMetadata struct {
	Name        string
	PieceLength int64
	PieceHashes [][]byte // 20-byte SHA-1 per global piece, in order
	Files       []TorrentFile
}

// sanitizeComponent validates a single path component of a torrent file
// path. Components must be non-empty, contain no separators or traversal,
// and be printable UTF-8. Anything else fails closed.
func sanitizeComponent(comp string) (string, error) {
	if comp == "" || comp == "." || comp == ".." {
		return "", errors.New("unsafe torrent path component")
	}
	if strings.ContainsAny(comp, `/\`) || strings.Contains(comp, "\x00") {
		return "", errors.New("unsafe torrent path component")
	}
	for _, r := range comp {
		if r < 0x20 || r == 0x7f {
			return "", errors.New("unsafe torrent path component")
		}
	}
	return comp, nil
}

// parseTorrent parses the .torrent bytes and returns the sanitized
// metadata. The path of every file is sanitized; traversal or unsafe
// components fail closed (the whole torrent is rejected).
func parseTorrent(data []byte) (*TorrentMetadata, error) {
	root, err := parseBencode(data)
	if err != nil {
		return nil, err
	}
	if root.typ != 'd' {
		return nil, errors.New("torrent root is not a dict")
	}
	info, ok := root.d["info"]
	if !ok || info.typ != 'd' {
		return nil, errors.New("torrent has no info dict")
	}
	meta := &TorrentMetadata{}
	if name, ok := info.d["name"]; ok && name.typ == 's' {
		meta.Name = string(name.s)
	}
	pl, ok := info.d["piece length"]
	if !ok || pl.typ != 'i' || pl.i <= 0 {
		return nil, errors.New("torrent has no valid piece length")
	}
	meta.PieceLength = pl.i
	pieces, ok := info.d["pieces"]
	if !ok || pieces.typ != 's' || len(pieces.s)%20 != 0 || len(pieces.s) == 0 {
		return nil, errors.New("torrent has no valid piece hashes")
	}
	for i := 0; i < len(pieces.s); i += 20 {
		h := make([]byte, 20)
		copy(h, pieces.s[i:i+20])
		meta.PieceHashes = append(meta.PieceHashes, h)
	}
	if files, ok := info.d["files"]; ok {
		if files.typ != 'l' {
			return nil, errors.New("torrent files is not a list")
		}
		for _, f := range files.l {
			if f.typ != 'd' {
				return nil, errors.New("torrent file entry is not a dict")
			}
			lenV, ok := f.d["length"]
			if !ok || lenV.typ != 'i' || lenV.i < 0 {
				return nil, errors.New("torrent file has no valid length")
			}
			pathV, ok := f.d["path"]
			if !ok || pathV.typ != 'l' || len(pathV.l) == 0 {
				return nil, errors.New("torrent file has no valid path")
			}
			var comps []string
			for _, c := range pathV.l {
				if c.typ != 's' {
					return nil, errors.New("torrent file path component is not a string")
				}
				sc, err := sanitizeComponent(string(c.s))
				if err != nil {
					return nil, err
				}
				comps = append(comps, sc)
			}
			meta.Files = append(meta.Files, TorrentFile{
				Index:  len(meta.Files) + 1,
				Path:   strings.Join(comps, "/"),
				Length: lenV.i,
			})
		}
	} else {
		// Single-file torrent: the info dict itself carries length + name.
		lenV, ok := info.d["length"]
		if !ok || lenV.typ != 'i' || lenV.i < 0 {
			return nil, errors.New("single-file torrent has no length")
		}
		meta.Files = append(meta.Files, TorrentFile{
			Index:  1,
			Path:   meta.Name,
			Length: lenV.i,
		})
	}
	if len(meta.Files) == 0 {
		return nil, errors.New("torrent has no files")
	}
	return meta, nil
}

// sortedTorrentFiles returns the saved *.torrent in dir (deterministic).
func savedTorrentPath(dir string) (string, error) {
	matches, err := filepath.Glob(filepath.Join(dir, "*.torrent"))
	if err != nil {
		return "", err
	}
	if len(matches) == 0 {
		return "", errors.New("no saved metadata torrent in job dir")
	}
	sort.Strings(matches)
	return matches[0], nil
}

// loadSavedTorrent reads and parses the aria2-saved .torrent from dir.
func loadSavedTorrent(dir string) (*TorrentMetadata, error) {
	path, err := savedTorrentPath(dir)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return parseTorrent(data)
}
