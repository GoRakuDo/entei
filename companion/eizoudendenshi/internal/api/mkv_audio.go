package api

import (
	"net/http"
	"os/exec"
	"strings"
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

// serveMKVJapaneseAudioFromPath serves an MKV through ffmpeg selecting
// only the Japanese audio track. Reads from a local file path.
// Does NOT support Range requests.
func (s *Server) serveMKVJapaneseAudioFromPath(w http.ResponseWriter, r *http.Request, diskPath string, fileName string) {
	cmd := exec.CommandContext(r.Context(), s.ffmpegPath,
		"-nostdin", "-v", "error",
		"-i", diskPath,
		"-map", "0:v?",
		"-map", "0:a:m:language:jpn",
		"-c", "copy",
		"-f", "matroska",
		"pipe:1",
	)
	cmd.Stdout = w
	w.Header().Set("Content-Type", "video/x-matroska")
	w.Header().Set("Accept-Ranges", "none")
	if err := cmd.Run(); err != nil {
		s.log.Infof("torrent", "mkv ffmpeg serve failed: %v file=%s", err, fileName)
	}
}
