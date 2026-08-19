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

// mkvAudioInfo holds the result of probing an MKV's audio tracks.
type mkvAudioInfo struct {
	trackCount  int  // number of audio tracks
	hasJapanese bool // whether a Japanese audio track exists
	probeOK     bool // whether probing succeeded
}

// probeMKVAudioTracks uses ffprobe to detect the audio track count and
// whether a Japanese audio track exists in the given MKV data.
//
// The reader must be seekable (anacrolix Reader). After probing, the
// reader is rewound to position 0 so the caller can re-read from the start.
//
// Conditions for Japanese audio selection:
//   - MKV file (extension check done by caller)
//   - ffmpeg is configured (s.ffmpegPath != "")
//   - trackCount >= 2
//   - hasJapanese == true
func probeMKVAudioTracks(ctx context.Context, r io.ReadSeeker, ffmpegPath string) mkvAudioInfo {
	if ffmpegPath == "" {
		return mkvAudioInfo{}
	}

	// Probe stream info by piping a header snippet to ffmpeg.
	// ffmpeg -i prints stream metadata to stderr even on decode error.

	// Read up to 2MB for the MKV header (enough for header + Cues).
	// The header contains track definitions.
	const maxProbeBytes = 2 * 1024 * 1024
	buf := make([]byte, maxProbeBytes)
	n, err := r.Read(buf)
	if err != nil && err != io.EOF {
		return mkvAudioInfo{}
	}
	buf = buf[:n]

	// Rewind so the caller can re-read from the start.
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return mkvAudioInfo{}
	}

	// Run ffmpeg with the probed data to get stream info.
	// ffmpeg -f matroska -i pipe:0 -f null - 2>&1
	// This reads the header and prints stream info to stderr.
	cmd := exec.CommandContext(ctx, ffmpegPath,
		"-nostdin", "-i", "pipe:0",
		"-f", "null", "-",
	)
	cmd.Stdin = bytes.NewReader(buf)
	stderr, err := cmd.CombinedOutput()
	if err != nil {
		// ffmpeg may fail if the data is incomplete, but it still
		// prints stream info before failing. Parse what we can.
	}

	// Parse the stderr output for audio stream info.
	// ffmpeg output looks like:
	//   Stream #0:0: Video: h264, ...
	//   Stream #0:1(jpn): Audio: aac, 48000 Hz, ...
	//   Stream #0:2(eng): Audio: aac, 48000 Hz, ...
	//   Stream #0:3: Subtitle: srt, ...
	return parseFFmpegStreamInfo(string(stderr))
}

// parseFFmpegStreamInfo parses ffmpeg's stderr output to extract
// audio track count and Japanese track presence.
func parseFFmpegStreamInfo(output string) mkvAudioInfo {
	info := mkvAudioInfo{probeOK: true}
	lines := strings.Split(output, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "Stream #") {
			continue
		}
		// Check if this is an audio stream.
		if !strings.Contains(line, "Audio:") {
			continue
		}
		info.trackCount++

		// Check for Japanese language tag.
		// Tags appear as (jpn) or language:jpn in the line.
		lower := strings.ToLower(line)
		if strings.Contains(lower, "(jpn)") || strings.Contains(lower, "language:jpn") ||
			strings.Contains(lower, "lang:jpn") || strings.Contains(line, "(jpn)") {
			info.hasJapanese = true
		}
	}
	return info
}

// serveMKVJapaneseAudio serves an MKV file through ffmpeg, selecting
// only the Japanese audio track. The anacrolix Reader is piped to
// ffmpeg's stdin, and ffmpeg's matroska output is piped to the HTTP
// response.
//
// This function blocks until the response is complete or the context
// is cancelled. It does NOT support Range requests — the browser's
// initial playback request (Range: bytes=0-) is handled by ffmpeg
// reading from the start.
func (s *Server) serveMKVJapaneseAudio(w http.ResponseWriter, r *http.Request, reader io.ReadSeekCloser, fileName string, modtime time.Time) {
	// Build the ffmpeg command:
	// ffmpeg -i pipe:0 -map 0:v -map 0:a:m:language:ja -map 0:s? -c copy -f matroska pipe:1
	//
	// -map 0:v          — select all video streams
	// -map 0:a:m:language:ja — select Japanese audio streams only
	// -map 0:s?         — select all subtitle streams (? = ignore if none)
	// -c copy           — copy all streams without re-encoding
	// -f matroska       — output as Matroska
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
	// stderr is intentionally not captured: paths / helper details must
	// never reach the client or logs (redaction contract).

	// Set headers before starting ffmpeg. If ffmpeg fails after headers
	// were written, the client sees a truncated 200 — accepted trade-off.
	setTorrentMediaHeaders(w)
	w.Header().Set("Content-Type", "video/x-matroska")

	if err := cmd.Run(); err != nil {
		// ffmpeg error: stderr is swallowed (redaction contract).
		// The response may be partially written; we can't change the
		// status code at this point.
		log.Printf("mkv japanese audio: ffmpeg error: %v", err)
		return
	}
}

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
