//go:build !android

// Non-Android builds: the OS resolver works (Windows uses the system
// resolver; Linux reads /etc/resolv.conf normally), so the default
// net.DefaultResolver is correct. Nothing to install.
package main

// installAndroidDNSResolver is a no-op on every platform except Android
// (see install_android.go for the Termux implementation).
func installAndroidDNSResolver() {}
