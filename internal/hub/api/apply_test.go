package api

import (
	"connectrpc.com/connect"
	"encoding/json"
	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/hub/auth"
	"testing"
)

func TestApplyAuthorizesPayloadIdentity(t *testing.T) {
	f := newFixture(t)
	mustGrant(t, f.st, f.ids["operator@x"], f.cID, auth.RoleOperator, []string{"shop"})
	for _, tc := range []struct {
		name, envelopeNS, bodyNS string
		want                     connect.Code
	}{
		{"spoofed namespace", "shop", "kube-system", connect.CodeInvalidArgument},
		{"outside grant", "kube-system", "kube-system", connect.CodePermissionDenied},
		{"inside grant", "shop", "shop", connect.CodeUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, err := json.Marshal(map[string]interface{}{"apiVersion": "v1", "kind": "Secret", "metadata": map[string]string{"name": "s", "namespace": tc.bodyNS}})
			if err != nil {
				t.Fatal(err)
			}
			_, err = f.cluster.Apply(f.as(t, "operator@x"), connect.NewRequest(&kmatev1.ClusterApplyRequest{ClusterId: f.cID, Apply: &kmatev1.ApplyRequest{Object: &kmatev1.KubeObject{Json: body, ApiVersion: "v1", Kind: "Secret", Name: "s", Namespace: tc.envelopeNS}}}))
			if connect.CodeOf(err) != tc.want {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
}
