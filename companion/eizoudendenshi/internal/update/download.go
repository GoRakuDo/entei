package update

import (
	"archive/zip"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// maxRedirects bounds the redirect chain (the default Go limit is 10;
// the update contract demands at most 5).
const maxRedirects = 5

// maxArtifactBytes caps a downloaded artifact so a hostile release can
// never force unbounded disk usage (the ffmpeg archive is ~77 MB).
const maxArtifactBytes = 1 << 30

// maxManifestBytes caps the manifest fetch (the real manifest is ~1 KB).
const maxManifestBytes = 1 << 20

// termuxSystemCABundle is the CA bundle Termux installs and serves to
// OpenSSL/curl clients (mirror of /data/.../usr/etc/tls/cert.pem). Go's
// x509 system-root scan (root_linux.go) does NOT include it: on Android,
// Go only looks at /etc/ssl/* (absent in Termux) and
// /system/etc/security/cacerts (Android's own bundle, which a Termux-
// provisioned app under CGO_ENABLED=0 may not resolve). Without this
// fallback the update check fails TLS handshake with "could not check for
// updates" even though curl on the same device succeeds.
const termuxSystemCABundle = "/data/data/com.termux/files/usr/etc/tls/cert.pem"

// newHardenedClient returns the default HTTP client: bounded total
// timeout, at most 5 redirects, HTTPS-only redirect targets, and a TLS
// root-pool that includes the Termux CA bundle when running on Termux.
// GitHub Release asset URLs 302-redirect to the release CDN; any
// redirect that leaves https:// fails closed.
func newHardenedClient() *http.Client {
	return &http.Client{
		Timeout: 60 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// via includes the original request, so len(via) > max
			// allows exactly maxRedirects redirects (mirrors curl
			// --max-redirs 5).
			if len(via) > maxRedirects {
				return errors.New("update: too many redirects")
			}
			if req.URL.Scheme != "https" {
				return errors.New("update: non-HTTPS redirect")
			}
			return nil
		},
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{RootCAs: systemRootPoolWithTermux()},
		},
	}
}

// systemRootPoolWithTermux returns a cert pool that starts from the OS
// system roots and, when the Termux CA bundle is present on this device,
// appends it. On non-Termux systems the pool contains the OS roots only
// (identical to Go's default when the fallback file is absent).
func systemRootPoolWithTermux() *x509.CertPool {
	pool, errSys := x509.SystemCertPool()
	if errSys != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if pem, err := os.ReadFile(termuxSystemCABundle); err == nil {
		pool.AppendCertsFromPEM(pem)
	}
	return pool
}

// fetch downloads url into staging under name with a bounded size and
// stores it mode 0600. Failures remove the partial file.
func fetch(client *http.Client, staging, name, url string, cap int64) (string, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "grkd-edds-updater")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", errors.New("update: download failed")
	}
	dest := filepath.Join(staging, name)
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return "", err
	}
	n, err := io.Copy(f, io.LimitReader(resp.Body, cap+1))
	closeErr := f.Close()
	if err != nil || closeErr != nil || n > cap {
		os.Remove(dest)
		return "", errors.New("update: download failed")
	}
	return dest, nil
}

// sha256Hex returns the lowercase hex SHA-256 of the file at path.
func sha256Hex(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// extractExpectedMember extracts exactly the member named expected from
// the verified zip archive into staging under stagedName. Traversal and
// symlinks are impossible: only a single regular file with the exact
// expected basename is taken (duplicates fail closed).
func extractExpectedMember(zipPath, stagedName, expected string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return errors.New("update: cannot open the verified archive")
	}
	defer zr.Close()
	var found *zip.File
	for _, f := range zr.File {
		name := path.Clean(f.Name)
		if name == "." || strings.HasPrefix(name, "/") || strings.Contains(name, "..") {
			continue
		}
		if path.Base(name) != expected || f.FileInfo().IsDir() {
			continue
		}
		if f.Mode()&os.ModeSymlink != 0 {
			continue
		}
		if found != nil {
			return errors.New("update: duplicate member in the verified archive")
		}
		found = f
	}
	if found == nil {
		return errors.New("update: verified archive is missing the expected member")
	}
	if found.UncompressedSize64 > maxArtifactBytes {
		return errors.New("update: verified archive member is too large")
	}
	rc, err := found.Open()
	if err != nil {
		return errors.New("update: cannot read the verified archive member")
	}
	defer rc.Close()
	dest := filepath.Join(filepath.Dir(zipPath), stagedName)
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o700)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, rc)
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil {
		os.Remove(dest)
		return errors.New("update: cannot extract the verified archive member")
	}
	return nil
}

// stageRelease downloads and verifies the manifest and the platform
// artifacts into staging. Nothing outside staging is touched here:
// every artifact is Minisign-verified AND checked against the signed
// manifest's SHA-256 BEFORE it is considered staged.
func stageRelease(client *http.Client, verifier, staging, installRoot string, rel *Release) (*applyPlan, error) {
	mfPath, err := fetch(client, staging, manifestAssetName, rel.Assets[manifestAssetName].URL, maxManifestBytes)
	if err != nil {
		return nil, err
	}
	if _, err := fetch(client, staging, manifestAssetName+".minisig",
		rel.Assets[manifestAssetName].URL+".minisig", maxManifestBytes); err != nil {
		return nil, err
	}
	if err := verifyMinisign(verifier, mfPath, staging); err != nil {
		return nil, err
	}
	mfBytes, err := os.ReadFile(mfPath)
	if err != nil {
		return nil, err
	}
	man, err := parseManifest(mfBytes)
	if err != nil {
		return nil, err
	}
	// The manifest version must equal the selected tag suffix
	// (e.g. both 0.2.0-rc.22).
	if man.Version != rel.Version {
		return nil, errors.New("update: manifest version does not match the release tag")
	}
	plan, err := man.platformPlan(installRoot, rel)
	if err != nil {
		return nil, err
	}

	for _, sf := range plan.Files {
		src, err := fetch(client, staging, sf.SourceName, rel.Assets[sf.SourceName].URL, maxArtifactBytes)
		if err != nil {
			return nil, err
		}
		if _, err := fetch(client, staging, sf.SourceName+".minisig",
			rel.Assets[sf.SourceName].URL+".minisig", maxManifestBytes); err != nil {
			return nil, err
		}
		if err := verifyMinisign(verifier, src, staging); err != nil {
			return nil, err
		}
		got, err := sha256Hex(src)
		if err != nil {
			return nil, err
		}
		if got != sf.SHA256 {
			return nil, errors.New("update: artifact SHA-256 does not match the signed manifest")
		}
		if sf.Archive {
			if err := extractExpectedMember(src, sf.StagedName, sf.Expected); err != nil {
				return nil, err
			}
			os.Remove(src)
			os.Remove(src + ".minisig")
		}
		if fi, err := os.Stat(filepath.Join(staging, sf.StagedName)); err != nil || fi.IsDir() || fi.Size() == 0 {
			return nil, errors.New("update: staged artifact is invalid")
		}
	}
	return plan, nil
}
