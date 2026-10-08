package ca

import "net/url"

// uriScheme namespaces the SANs the hub writes into agent certificates so they
// cannot be confused with a real URL.
const uriScheme = "kmate"

func identityURIs(clusterID, agentID string) []*url.URL {
	out := []*url.URL{{Scheme: uriScheme, Host: "cluster", Path: "/" + clusterID}}
	if agentID != "" {
		out = append(out, &url.URL{Scheme: uriScheme, Host: "agent", Path: "/" + agentID})
	}
	return out
}
