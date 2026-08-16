//go:build js && wasm

// subtitle_test.go - the Blob input path of extractSubtitleVTTJS: a Blob/File
// must be served to ExtractSubtitleWebVTT through the ranged blobReader (never
// loaded whole), and the output must match the Uint8Array path. Run with a wasm
// runtime (node + $(go env GOROOT)/lib/wasm/wasm_exec.js); skipped by the
// native test run.

package main

import (
	"bytes"
	"strings"
	"syscall/js"
	"testing"

	"github.com/gravity-zero/mkvgo/mkv"
	"github.com/gravity-zero/mkvgo/mkv/writer"
)

// buildSubtitleMKV returns a matroska carrying one SRT subtitle track, built
// through the writer (pure Go, no JS needed). With junkSize > 0 a large uncued
// other-track cluster sits between the subtitle clusters, so the file is far
// larger than any subtitle payload - the shape that must never be loaded whole.
func buildSubtitleMKV(t *testing.T, junkSize int) []byte {
	t.Helper()
	mem := mkv.NewMemFS()
	fs := mem.FS()
	w, err := fs.DoCreate("in.mkv")
	if err != nil {
		t.Fatal(err)
	}
	mw := writer.NewMKVWriter(w)
	if err := mw.WriteStart(); err != nil {
		t.Fatal(err)
	}
	c := &mkv.Container{Info: mkv.SegmentInfo{TimecodeScale: 1_000_000, MuxingApp: "test", WritingApp: "test"}}
	if err := mw.WriteMetadata(c, []mkv.Track{{ID: 1, Type: mkv.SubtitleTrack, Codec: "srt"}}, 3000); err != nil {
		t.Fatal(err)
	}
	// Subtitle-only file: WriteClusterWithCues emits a cue for the track, so the
	// Cues-driven extraction path runs on the Blob too.
	if err := mw.WriteClusterWithCues(0, 1_000_000, []mkv.Block{
		{TrackNumber: 1, Timecode: 1000, Duration: 1000, Data: []byte("Hello from Blob")},
	}); err != nil {
		t.Fatal(err)
	}
	if junkSize > 0 {
		if err := writer.WriteCluster(w, 2000, 1_000_000, []mkv.Block{
			{TrackNumber: 2, Timecode: 2000, Keyframe: true, Data: bytes.Repeat([]byte{'j'}, junkSize)},
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := mw.WriteClusterWithCues(2000, 1_000_000, []mkv.Block{
		{TrackNumber: 1, Timecode: 2000, Duration: 1000, Data: []byte("Second from Blob")},
	}); err != nil {
		t.Fatal(err)
	}
	if err := mw.Finalize(); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return mem.Get("in.mkv")
}

func toJSBlob(b []byte) js.Value {
	u8 := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(u8, b)
	return js.Global().Get("Blob").New([]any{u8}, map[string]any{"type": "application/octet-stream"})
}

// awaitJS settles a JS Promise synchronously for the test. Legal here because
// promise() runs its work on a separate goroutine, which the wasm runtime
// schedules while this goroutine blocks on the channel.
func awaitJS(t *testing.T, p js.Value) js.Value {
	t.Helper()
	done := make(chan struct{})
	var result, errVal js.Value
	then := js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) > 0 {
			result = args[0]
		}
		close(done)
		return nil
	})
	catch := js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) > 0 {
			errVal = args[0]
		}
		close(done)
		return nil
	})
	defer then.Release()
	defer catch.Release()
	p.Call("then", then).Call("catch", catch)
	<-done
	if errVal.Type() != js.TypeUndefined {
		t.Fatalf("promise rejected: %s", errVal.Call("toString").String())
	}
	return result
}

// TestExtractSubtitleVTT_Blob drives extractSubtitleVTTJS with a Blob/File input
// and checks the returned WebVTT against the source cue.
func TestExtractSubtitleVTT_Blob(t *testing.T) {
	data := buildSubtitleMKV(t, 0)
	out := awaitJS(t, extractSubtitleVTTJS(js.Value{}, []js.Value{toJSBlob(data), js.ValueOf(1)}).(js.Value))
	got := out.String()
	for _, want := range []string{"WEBVTT", "Hello from Blob", "00:00:01.000 --> 00:00:02.000"} {
		if !strings.Contains(got, want) {
			t.Errorf("Blob extraction missing %q:\n%s", want, got)
		}
	}
}

// TestExtractSubtitleVTT_BlobLargeFile drives the same export over a file
// dominated by a large uncued cluster (a 13 GB movie's stand-in): the Blob path
// must serve it through the ranged blobReader and still extract both subtitle
// cues - the whole input is never transferred to Go.
func TestExtractSubtitleVTT_BlobLargeFile(t *testing.T) {
	data := buildSubtitleMKV(t, 3<<20)
	out := awaitJS(t, extractSubtitleVTTJS(js.Value{}, []js.Value{toJSBlob(data), js.ValueOf(1)}).(js.Value))
	got := out.String()
	for _, want := range []string{"Hello from Blob", "Second from Blob"} {
		if !strings.Contains(got, want) {
			t.Errorf("Blob extraction over a multi-MB file missing %q:\n%s", want, got)
		}
	}
}
