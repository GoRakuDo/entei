package api

import "testing"

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
