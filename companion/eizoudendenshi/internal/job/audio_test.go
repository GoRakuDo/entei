package job

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAudioMediaTypeForPath(t *testing.T) {
	cases := map[string]string{
		"media.m4a":  "audio/mp4",
		"media.aac":  "audio/aac",
		"media.opus": "audio/ogg",
		"media.webm": "audio/webm",
		"media.mp3":  "audio/mpeg",
		"media.ogg":  "audio/ogg",
	}
	for name, want := range cases {
		if got := audioMediaTypeForPath(filepath.Join("job", name)); got != want {
			t.Errorf("audioMediaTypeForPath(%q) = %q, want %q", name, got, want)
		}
	}
	for _, name := range []string{"media.mp4", "media.flac", "media", "media.wav"} {
		if got := audioMediaTypeForPath(name); got != "" {
			t.Errorf("audioMediaTypeForPath(%q) = %q, want unsupported", name, got)
		}
	}
}

func TestHelperArgsAudioUsesOriginalPassthrough(t *testing.T) {
	url := "https://www.youtube.com/watch?v=abcdefghijk"
	args := helperArgs("C:/private/job", url, ModeAudio)
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-f "+audioFormat) {
		t.Fatalf("audio args missing %q selector: %v", audioFormat, args)
	}
	if !strings.Contains(joined, "--no-part") {
		t.Fatalf("audio args must wait for the completed original file: %v", args)
	}
	if strings.Contains(joined, "--extract-audio") {
		t.Fatalf("audio args must not invoke extraction/transcoding: %v", args)
	}
	if args[len(args)-1] != url {
		t.Fatalf("final argv element = %q, want canonical URL %q", args[len(args)-1], url)
	}
}

func TestAudioJobKeepsOriginalExtensionAndMime(t *testing.T) {
	setFakeEnv(t, "EIZOU_FAKE_EXT", "m4a")
	setFakeEnv(t, "EIZOU_FAKE_SIZE", "256")
	setFakeEnv(t, "EIZOU_FAKE_HOLD", "")
	m := newTestManager(t, 0)
	snap, err := m.Start("https://www.youtube.com/watch?v=abcdefghijk", ModeAudio)
	if err != nil {
		t.Fatalf("Start audio: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		current := m.Get(snap.ID)
		if current == nil {
			t.Fatal("audio job disappeared")
		}
		if current.State == StateComplete {
			if current.MediaType != "audio/mp4" {
				t.Fatalf("Snapshot.MediaType = %q, want audio/mp4", current.MediaType)
			}
			return
		}
		if current.State == StateError {
			t.Fatalf("audio job errored: %s", current.Error)
		}
		if time.Now().After(deadline) {
			t.Fatalf("audio job did not complete: %+v", current)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
