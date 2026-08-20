package api

import (
	"bytes"
	"context"
	"fmt"
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

// probeMKVJapaneseAudio tries increasing probe sizes (2 MB → 64 MB) to
// detect audio tracks in MKV files. FFmpeg's matroska demuxer must read
// through Attachments (fonts etc.) before emitting stream info; small
// probes can hit "File ended prematurely" when many attachments exist.
// Returns true when any audio track is Japanese.
func probeMKVJapaneseAudio(ctx context.Context, r io.ReadSeeker, ffmpegPath string) (bool, string) {
	probeSizes := []int{
		2 * 1024 * 1024,  // 2 MB
		4 * 1024 * 1024,  // 4 MB
		8 * 1024 * 1024,  // 8 MB
		16 * 1024 * 1024, // 16 MB
		32 * 1024 * 1024, // 32 MB
		64 * 1024 * 1024, // 64 MB (max)
	}

	for i, size := range probeSizes {
		buf := make([]byte, size)
		n, err := io.ReadFull(r, buf)

		// On first probe size, retry if no data (torrent may still be buffering
		// during initial data arrival).
		if i == 0 && (n == 0 || (err != nil && err != io.EOF && err != io.ErrUnexpectedEOF)) {
			for retry := 0; retry < 3; retry++ {
				if _, seekErr := r.Seek(0, io.SeekStart); seekErr != nil {
					return false, "seek_failed_retry"
				}
				time.Sleep(1 * time.Second)
				n, err = io.ReadFull(r, buf)
				if n > 0 {
					break
				}
			}
		}

		if n == 0 {
			return false, "no_data_read" // empty / tiny file
		}
		if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
			break
		}
		buf = buf[:n]

		// Rewind for next attempt or for the actual serve.
		if _, seekErr := r.Seek(0, io.SeekStart); seekErr != nil {
			return false, "seek_failed"
		}

		// Probe with ffmpeg.
		cmd := exec.CommandContext(ctx, ffmpegPath,
			"-nostdin", "-i", "pipe:0",
			"-f", "null", "-",
		)
		cmd.Stdin = bytes.NewReader(buf)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		_ = cmd.Run() // error expected; stream info is printed before decode starts

		audioCount, hasJapanese := parseProbeOutput(stderr.String())
		if audioCount <= 1 {
			// Single audio track: nothing to select. No Japanese variant exists.
			return false, fmt.Sprintf("single_track_at_%dmb", size/(1024*1024))
		}
		if hasJapanese {
			return true, fmt.Sprintf("japanese_found_at_%dmb_audioCount=%d", size/(1024*1024), audioCount)
		}
		// audioCount >= 2 but no Japanese detected yet — the metadata may
		// sit beyond the current probe window. Try the next (larger) size.
	}

	return false, "ffmpeg_failed_all_sizes_exhausted" // all sizes exhausted
}

// parseProbeOutput parses the stderr output of "ffmpeg -i" and returns the
// number of input audio streams detected and whether any of them is Japanese.
// Only the input section (before "Output #" / "Stream mapping:") is scanned
// to avoid counting ffmpeg's own output stream lines.
func parseProbeOutput(output string) (audioCount int, hasJapanese bool) {
	// Trim to the input section only.
	inputSection := output
	for _, marker := range []string{"Output #", "Stream mapping"} {
		if idx := strings.Index(inputSection, marker); idx >= 0 {
			inputSection = inputSection[:idx]
		}
	}

	lines := strings.Split(inputSection, "\n")
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
func (s *Server) serveMKVJapaneseAudio(w http.ResponseWriter, r *http.Request, reader io.ReadSeekCloser, fileName string) {
	cmd := exec.CommandContext(r.Context(), s.ffmpegPath,
		"-nostdin", "-v", "error",
		"-i", "pipe:0",
		"-map", "0:v",
		"-map", "0:m:language:jpn",
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
