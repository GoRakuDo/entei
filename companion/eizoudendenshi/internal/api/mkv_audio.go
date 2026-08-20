package api

import (
	"bytes"
	"context"
	"io"
	"log"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// isMKVExtension reports whether the filename has an .mkv extension
// (case-insensitive).
func isMKVExtension(fileName string) bool {
	ext := ""
	for i := len(fileName) - 1; i >= 0; i-- {
		if fileName[i] == '.' {
			ext = fileName[i+1:]
			break
		}
	}
	return strings.EqualFold(ext, "mkv")
}

// probeMKVJapaneseAudio reads the first 2 MB of r, pipes it to ffmpeg to
// detect audio tracks and their languages, then rewinds r to position 0.
// Returns true when exactly 2 audio tracks exist and at least one is
// Japanese — the condition under which serveMKVJapaneseAudio should be used.
func probeMKVJapaneseAudio(ctx context.Context, r io.ReadSeeker, ffmpegPath string) bool {
	const probeSize = 2 * 1024 * 1024

	buf := make([]byte, probeSize)
	n, err := io.ReadFull(r, buf)
	if err == io.EOF {
		return false // empty / tiny file — not a valid MKV
	}
	// err == nil (full read) or io.ErrUnexpectedEOF (partial read) — both OK.
	buf = buf[:n]

	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return false
	}

	cmd := exec.CommandContext(ctx, ffmpegPath,
		"-nostdin", "-i", "pipe:0",
		"-f", "null", "-",
	)
	cmd.Stdin = bytes.NewReader(buf)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	_ = cmd.Run() // error expected; stream info is printed before decode starts

	audioCount, hasJapanese := parseProbeOutput(stderr.String())
	return audioCount == 2 && hasJapanese
}

// parseProbeOutput parses the stderr output of "ffmpeg -i" and returns the
// number of audio streams detected and whether any of them is Japanese.
func parseProbeOutput(output string) (audioCount int, hasJapanese bool) {
	lines := strings.Split(output, "\n")
	for i, line := range lines {
		if !strings.Contains(strings.TrimSpace(line), "Audio:") {
			continue
		}
		audioCount++
		// Scan this line and the following metadata lines for language info.
		for j := i; j < len(lines) && j < i+10; j++ {
			l := lines[j]
			// Stream line with language in parentheses: Stream #0:1(jpn): Audio:
			if strings.Contains(l, "(jpn)") || strings.Contains(l, "(ja)") {
				hasJapanese = true
				break
			}
			// Metadata line: "      language        : jpn"
			if strings.Contains(l, "language") {
				parts := strings.SplitN(l, ":", 2)
				if len(parts) == 2 {
					val := strings.TrimSpace(parts[1])
					if strings.HasPrefix(val, "jpn") || strings.HasPrefix(val, "ja") {
						hasJapanese = true
						break
					}
				}
			}
		}
	}
	return
}

// serveMKVJapaneseAudio pipes the MKV through ffmpeg, selecting only
// the Japanese audio track. Blocks until the response is complete.
// Does NOT support Range requests.
func (s *Server) serveMKVJapaneseAudio(w http.ResponseWriter, r *http.Request, reader io.ReadSeekCloser, fileName string, modtime time.Time) {
	cmd := exec.CommandContext(r.Context(), s.ffmpegPath,
		"-nostdin", "-v", "error",
		"-i", "pipe:0",
		"-map", "0:v",
		"-map", "0:a:m:language:ja",
		"-map", "0:s?",
		"-c", "copy",
		"-f", "matroska",
		"pipe:1",
	)
	cmd.Stdin = reader
	cmd.Stdout = w
	setTorrentMediaHeaders(w)
	w.Header().Set("Accept-Ranges", "none")
	w.Header().Set("Content-Type", "video/x-matroska")
	if err := cmd.Run(); err != nil {
		log.Printf("mkv japanese audio: ffmpeg error: %v", err)
	}
}
