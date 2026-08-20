package api

import (
	"io"
	"testing"
)

// ---------------------------------------------------------------------------
// isMKVExtension
// ---------------------------------------------------------------------------

func TestIsMKVExtension(t *testing.T) {
	tests := []struct {
		name string
		file string
		want bool
	}{
		{"lowercase", "video.mkv", true},
		{"uppercase", "video.MKV", true},
		{"mixed", "video.Mkv", true},
		{"dotted", "video.mkv.txt", false},
		{"noext", "video", false},
		{"empty", "", false},
		{"dotonly", ".", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isMKVExtension(tt.file); got != tt.want {
				t.Errorf("isMKVExtension(%q) = %v, want %v", tt.file, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// parseProbeOutput — unit tests against mock ffmpeg stderr
// ---------------------------------------------------------------------------

func TestParseProbeOutput(t *testing.T) {
	tests := []struct {
		name         string
		output       string
		wantAudio    int
		wantJapanese bool
	}{
		{
			name:      "empty",
			output:    "",
			wantAudio: 0,
		},
		{
			name: "1 audio track Japanese",
			output: `Input #0, matroska,webm, from 'pipe:0':
          Stream #0:0: Video: h264
          Stream #0:1: Audio: aac
            Metadata:
              language        : jpn`,
			wantAudio:    1,
			wantJapanese: true,
		},
		{
			name: "2 audio tracks one Japanese metadata",
			output: `Input #0, matroska,webm, from 'pipe:0':
          Stream #0:0: Video: h264
          Stream #0:1: Audio: aac
            Metadata:
              language        : jpn
          Stream #0:2: Audio: aac
            Metadata:
              language        : eng`,
			wantAudio:    2,
			wantJapanese: true,
		},
		{
			name: "2 audio tracks one Japanese parentheses",
			output: `Input #0, matroska,webm, from 'pipe:0':
          Stream #0:0: Video: h264
          Stream #0:1(jpn): Audio: aac
          Stream #0:2(eng): Audio: aac`,
			wantAudio:    2,
			wantJapanese: true,
		},
		{
			name: "2 audio tracks neither Japanese",
			output: `Input #0, matroska,webm, from 'pipe:0':
          Stream #0:0: Video: h264
          Stream #0:1: Audio: aac
            Metadata:
              language        : eng
          Stream #0:2: Audio: aac
            Metadata:
              language        : fre`,
			wantAudio: 2,
		},
		{
			name: "3 audio tracks one Japanese",
			output: `Input #0, matroska,webm, from 'pipe:0':
          Stream #0:0: Video: h264
          Stream #0:1: Audio: aac
            Metadata:
              language        : jpn
          Stream #0:2: Audio: aac
            Metadata:
              language        : eng
          Stream #0:3: Audio: aac
            Metadata:
              language        : fre`,
			wantAudio:    3,
			wantJapanese: true,
		},
		{
			name: "short ja tag",
			output: `Input #0, matroska,webm, from 'pipe:0':
          Stream #0:0: Video: h264
          Stream #0:1: Audio: aac
            Metadata:
              language        : ja
          Stream #0:2: Audio: aac
            Metadata:
              language        : eng`,
			wantAudio:    2,
			wantJapanese: true,
		},
		{
			name: "ja in parentheses",
			output: `Input #0, matroska,webm, from 'pipe:0':
          Stream #0:0: Video: h264
          Stream #0:1(ja): Audio: aac
          Stream #0:2(eng): Audio: aac`,
			wantAudio:    2,
			wantJapanese: true,
		},
		{
			name: "input+output sections counts only input",
			output: `Input #0, matroska,webm, from 'pipe:0':
          Stream #0:0: Video: h264
          Stream #0:1(jpn): Audio: aac
          Stream #0:2(eng): Audio: aac
    Output #0, null, to 'pipe:1':
          Stream #0:0: Video: h264 (copy)
          Stream #0:1: Audio: aac (copy)`,
			wantAudio:    2,
			wantJapanese: true,
		},
		{
			name: "input+stream mapping counts only input",
			output: `Input #0, matroska,webm, from 'pipe:0':
          Stream #0:0: Video: h264
          Stream #0:1(jpn): Audio: aac
    Stream mapping:
      Stream #0:0 -> #0:0 (copy)
      Stream #0:1 -> #0:1 (copy)`,
			wantAudio:    1,
			wantJapanese: true,
		},
		{
			name: "no audio streams",
			output: `Input #0, matroska,webm, from 'pipe:0':
          Stream #0:0: Video: h264`,
			wantAudio: 0,
		},
		{
			name:      "ffmpeg error only",
			output:    `Error: invalid data found when processing input`,
			wantAudio: 0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			audioCount, hasJapanese := parseProbeOutput(tt.output)
			if audioCount != tt.wantAudio {
				t.Errorf("audioCount = %d, want %d", audioCount, tt.wantAudio)
			}
			if hasJapanese != tt.wantJapanese {
				t.Errorf("hasJapanese = %v, want %v", hasJapanese, tt.wantJapanese)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// retryReader — mock io.ReadSeeker for testing retry behavior
// ---------------------------------------------------------------------------

// retryReader simulates a torrent reader that returns 0 bytes on the
// first N Read calls, then data — mimicking initial buffering delay.
type retryReader struct {
	data      []byte
	offset    int
	readsLeft int // how many reads return 0 before data flows
	seekCount int
}

func (r *retryReader) Read(p []byte) (int, error) {
	if r.readsLeft > 0 {
		r.readsLeft--
		return 0, nil // simulate no data yet
	}
	remaining := r.data[r.offset:]
	n := copy(p, remaining)
	r.offset += n
	if n == 0 {
		return 0, io.EOF
	}
	return n, nil
}

func (r *retryReader) Seek(offset int64, whence int) (int64, error) {
	if whence == io.SeekStart {
		r.offset = int(offset)
		r.seekCount++
	} else {
		return 0, io.ErrUnexpectedEOF
	}
	return int64(r.offset), nil
}

func TestRetryReaderFirstReadZeroBytes(t *testing.T) {
	// 32 KB of dummy data — just enough to exercise the retry path.
	data := make([]byte, 32*1024)
	for i := range data {
		data[i] = byte(i % 256)
	}
	r := &retryReader{
		data:      data,
		readsLeft: 3, // first 3 reads return 0 bytes
	}

	// Read once returning 0
	buf := make([]byte, len(data))
	n, err := r.Read(buf)
	if n != 0 || err != nil {
		t.Fatalf("expected 0 bytes on first read, got n=%d err=%v", n, err)
	}

	// After 3 zero-byte reads, data should flow
	var totalRead int
	for totalRead < len(data) {
		n, err = r.Read(buf[totalRead:])
		totalRead += n
		if err != nil && err != io.EOF {
			t.Fatalf("unexpected error after retries: %v", err)
		}
	}
	if totalRead != len(data) {
		t.Fatalf("expected to read %d bytes after retries, got %d", len(data), totalRead)
	}
}

func TestRetryReaderSeekResetsOffset(t *testing.T) {
	data := make([]byte, 1024)
	for i := range data {
		data[i] = byte(i)
	}
	r := &retryReader{data: data, readsLeft: 0}

	// Read some data
	buf := make([]byte, 512)
	r.Read(buf)

	// Seek back to start
	r.Seek(0, io.SeekStart)

	// Re-read should return same data from start
	buf2 := make([]byte, 512)
	n, _ := r.Read(buf2)
	if n != 512 {
		t.Fatalf("expected 512 bytes after seek, got %d", n)
	}
	for i := 0; i < 512; i++ {
		if buf[i] != buf2[i] {
			t.Fatalf("mismatch at byte %d: %d vs %d", i, buf[i], buf2[i])
		}
	}
	if r.seekCount != 1 {
		t.Fatalf("expected seekCount=1, got %d", r.seekCount)
	}
}
