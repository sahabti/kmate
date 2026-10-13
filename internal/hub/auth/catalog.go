package auth

import (
	"context"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"google.golang.org/protobuf/proto"
)

// FilterCatalog returns a private snapshot containing only namespaces in the grant.
// Never change the shared persisted snapshot or the broadcaster's message.
func FilterCatalog(ctx context.Context, clusterID string, cat *kmatev1.Catalog) *kmatev1.Catalog {
	if cat == nil {
		return &kmatev1.Catalog{}
	}
	out := proto.Clone(cat).(*kmatev1.Catalog)
	out.Entries = nil
	p := FromContext(ctx)
	for _, e := range cat.GetEntries() {
		if p != nil && p.CanAccessCluster(clusterID) && p.NamespaceAllowed(clusterID, e.GetNamespace()) {
			out.Entries = append(out.Entries, proto.Clone(e).(*kmatev1.CatalogEntry))
		}
	}
	return out
}
