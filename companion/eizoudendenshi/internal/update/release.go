package update

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Asset is one validated release asset.
type Asset struct {
	Name string
	URL  string
}

// Release is a selected EizouDendenshi release.
type Release struct {
	Tag         string
	Version     string
	PublishedAt time.Time
	Assets      map[string]Asset // asset name -> asset (validated, unique)
}

// safeAssetName is the strict asset-name contract: a plain basename with
// no separators, dot-dot, or other unsafe characters (mirrors the
// bootstrap's Assert-SafeLogicalName).
var safeAssetName = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// selectRelease queries the release feed and returns the NEWEST
// published (by published_at) non-draft release whose tag starts with
// the EizouDendenshi prefix. Prereleases are included (the latest
// release is always a prerelease and /releases/latest excludes them).
// Releases with malformed tags, missing dates, or no assets are skipped;
// a candidate carrying a missing/duplicate/unsafe asset name or a
// non-HTTPS asset URL is rejected in favor of the next-newest valid
// release (a poisoned old release must never block updates). No valid
// selectRelease queries the release feed and returns the NEWEST
// published (by published_at) non-draft release whose tag starts with
// the EizouDendenshi prefix. Prereleases are included (the latest
// release is always a prerelease and /releases/latest excludes them).
// Releases with malformed tags, missing dates, or no assets are skipped;
// a candidate carrying a missing/duplicate/unsafe asset name or a
// non-HTTPS asset URL is rejected in favor of the next-newest valid
// release (a poisoned old release must never block updates). No valid
// release at all fails closed.
func selectRelease(client *http.Client) (*Release, error) {
	req, err := http.NewRequest(http.MethodGet, releaseAPI, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "grkd-edds-updater")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("update: release feed unavailable")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}

	var feed []struct {
		TagName     string `json:"tag_name"`
		Draft       bool   `json:"draft"`
		PublishedAt string `json:"published_at"`
		Assets      []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &feed); err != nil {
		return nil, errors.New("update: release feed is not valid JSON")
	}

	var candidates []*Release
	for _, r := range feed {
		if r.Draft {
			continue
		}
		if !strings.HasPrefix(r.TagName, releaseTagPrefix) {
			continue
		}
		version := strings.TrimPrefix(r.TagName, releaseTagPrefix)
		if !semverShape.MatchString(version) {
			continue // malformed tag: not an EizouDendenshi release
		}
		published, err := time.Parse(time.RFC3339, r.PublishedAt)
		if err != nil {
			continue
		}
		if len(r.Assets) == 0 {
			continue
		}
		assets := make(map[string]Asset, len(r.Assets))
		valid := true
		for _, a := range r.Assets {
			if !safeAssetName.MatchString(a.Name) {
				valid = false
				break
			}
			if _, dup := assets[a.Name]; dup {
				valid = false
				break
			}
			if !httpsURL(a.BrowserDownloadURL) {
				valid = false
				break
			}
			assets[a.Name] = Asset{Name: a.Name, URL: a.BrowserDownloadURL}
		}
		if !valid {
			continue // poisoned candidate: never selected
		}
		candidates = append(candidates, &Release{
			Tag:         r.TagName,
			Version:     version,
			PublishedAt: published,
			Assets:      assets,
		})
	}
	if len(candidates) == 0 {
		return nil, errors.New("update: no matching release found")
	}

	// Newest first by published_at (never a lexical rc comparison).
	for i := 1; i < len(candidates); i++ {
		for j := i; j > 0 && candidates[j].PublishedAt.After(candidates[j-1].PublishedAt); j-- {
			candidates[j], candidates[j-1] = candidates[j-1], candidates[j]
		}
	}
	return candidates[0], nil
}

// httpsURL enforces the HTTPS-only asset URL contract: the scheme must
// be https, the host non-empty, and no userinfo, query, fragment, or
// whitespace may appear (mirrors the bootstrap's Assert-HttpsUrl).
func httpsURL(u string) bool {
	if !strings.HasPrefix(u, "https://") {
		return false
	}
	rest := u[len("https://"):]
	if rest == "" {
		return false
	}
	return !strings.ContainsAny(rest, "@?#\x20\t\r\n")
}

// releaseFailureCause reduces a release-feed error to a short, safe
// cause string for CLI output. The redaction contract requires that URLs,
// tokens, credentials, and local paths never appear: Go's *url.Error
// strips the underlying message; a DNS failure becomes "host resolution
// failed", a refused connection "connection refused", a TLS problem the
// underlying error, and everything else a generic fallback. The full URL
// is never echoed — a hostname is the most specific identifier allowed.
func releaseFailureCause(err error) string {
	if err == nil {
		return ""
	}
	// url.Error wraps the transport failure ("Get \"https://...\":
	// ..."); take only the inner cause text (after the colon) and drop the
	// quoted URL entirely.
	var uErr *url.Error
	if errors.As(err, &uErr) {
		err = uErr.Err
	}
	msg := err.Error()
	// Strip "unknown authority" / DHT-style host resolution problems into
	// a stable short label; everything else is truncated to a safe length.
	switch {
	case strings.Contains(msg, "no such host"),
		strings.Contains(msg, "server misbehaving"),
		strings.Contains(msg, "name or service not known"),
		strings.Contains(msg, "connection refused"):
		// First colon segment covers "dial tcp ...: connect: connection
		// refused" — keep only the final clause.
		if i := strings.LastIndex(msg, ": "); i >= 0 {
			msg = msg[i+2:]
		}
	}
	if len(msg) > 120 {
		msg = msg[:120] + "..."
	}
	if strings.TrimSpace(msg) == "" {
		return "feed unreachable"
	}
	return msg
}
