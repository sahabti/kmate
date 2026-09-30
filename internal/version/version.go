// Package version holds the build version injected via ldflags.
package version

// Version is set at build time with -ldflags "-X .../internal/version.Version=v1.2.3".
var Version = "dev"
