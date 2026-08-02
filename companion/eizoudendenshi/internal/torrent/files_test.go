package torrent

import "testing"

func TestTorrentFileInfoSplitsPath(t *testing.T) {
	cases := []struct {
		name string
		in   TorrentFile
		want FileInfo
	}{
		{
			"video mkv",
			TorrentFile{ID: "f0", Path: "Episode 01.mkv", Length: 2_000_000, Kind: KindVideo},
			FileInfo{ID: "f0", Basename: "Episode 01.mkv", Extension: "mkv", ByteSize: 2_000_000, Kind: KindVideo},
		},
		{
			"subtitle ass",
			TorrentFile{ID: "f1", Path: "Episode 01.ass", Length: 40_000, Kind: KindSubtitle},
			FileInfo{ID: "f1", Basename: "Episode 01.ass", Extension: "ass", ByteSize: 40_000, Kind: KindSubtitle},
		},
		{
			"no extension",
			TorrentFile{ID: "f2", Path: "README", Length: 100, Kind: KindOther},
			FileInfo{ID: "f2", Basename: "README", Extension: "", ByteSize: 100, Kind: KindOther},
		},
		{
			"uppercase ext lowercased",
			TorrentFile{ID: "f3", Path: "movie.MKV", Length: 500, Kind: KindVideo},
			FileInfo{ID: "f3", Basename: "movie.MKV", Extension: "mkv", ByteSize: 500, Kind: KindVideo},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := TorrentFileInfo(tc.in)
			if got != tc.want {
				t.Errorf("TorrentFileInfo(%+v) = %+v, want %+v", tc.in, got, tc.want)
			}
		})
	}
}
